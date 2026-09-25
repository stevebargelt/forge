// FG-807 dispatch integration: effort must survive the policy -> dispatch seam.
// Unit coverage in fg807-effort.test.ts owns schema and argv-template details;
// these tests drive the real invoke/runNext paths, task manifests, and event ledger.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { eventsForTask } from "../store/events.js";
import { tasksForRun } from "../store/tasks.js";
import { taskDir } from "../util/paths.js";
import { invoke } from "./invoke.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { startRun } from "./startRun.js";
import type { Workflow } from "./schema.js";
import type { TaskManifest } from "./task-manifest.js";

const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..", "..");
const savedEnv: Record<string, string | undefined> = {};
const envKeys = ["FORGE_HOME", "FORGE_WORKTREES", "ANTHROPIC_API_KEY"];
let db: DatabaseInstance;
let previousDb: DatabaseInstance | null;
let homeDir: string;
let projectDir: string;

function writePolicy(review = true): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "model-policy.yml"), `
schema_version: 2
on_unavailable: fail
model_profiles:
  subscription:
    provider: anthropic
    auth: subscription
    map:
      default: { model: claude-sonnet-test, cost_tier: standard }
      fast-orchestrator: { model: claude-haiku-test, cost_tier: cheap }
${review ? "      review: { model: claude-opus-test, cost_tier: premium, effort: low }" : ""}
defaults:
  profile: subscription
  activity:
    fast-orchestrator: subscription
`);
}

function installRuntime(): void {
  mkdirSync(join(homeDir, "runtimes"), { recursive: true });
  copyFileSync(join(repoRoot, "seeds", "runtimes", "claude-oauth.yml"), join(homeDir, "runtimes", "claude-oauth.yml"));
  publishFlatAsGeneration(homeDir);
}

function completedExec(calls: string[][]): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    calls.push(args);
    mkdirSync(dirname(stdoutPath), { recursive: true });
    writeFileSync(join(dirname(stdoutPath), "result.json"), JSON.stringify({ status: "complete", tests_run: 1 }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

function workflow(withRed = false, activity?: string): Workflow {
  return {
    name: "fg807-dispatch",
    description: "FG-807 effort dispatch integration",
    review_mode: "legacy_verdict",
    inputs: [{ name: "brief", required: true, type: "text" }],
    steps: [{
      id: "build",
      agent: "engineer",
      ...(activity ? { activity } : {}),
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude-oauth",
      reds: withRed ? [{ agent: "red-wide", authority: "specialist", gate_on_verdict: false }] : [],
    }],
  };
}

function modelEvent(taskId: string): Record<string, unknown> | undefined {
  return eventsForTask(taskId).find((event) => event.eventType === "model.profile_resolved")?.payload as Record<string, unknown> | undefined;
}

beforeEach(() => {
  for (const key of envKeys) savedEnv[key] = process.env[key];
  db = makeInMemoryDb();
  previousDb = setDbForTest(db);
  homeDir = mkdtempSync(join(tmpdir(), "fg807-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "fg807-project-"));
  process.env.FORGE_HOME = homeDir;
  process.env.FORGE_WORKTREES = "0";
  process.env.ANTHROPIC_API_KEY = "sk-test";
  writeFileSync(join(projectDir, "package.json"), "{}");
  installRuntime();
});

afterEach(() => {
  setDbForTest(previousDb as DatabaseInstance);
  db.close();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

test("FG-807: invoke and pipeline dispatch place low effort after model and record it in their receipts", async () => {
  writePolicy(true);
  const invokeCalls: string[][] = [];
  const invoked = await invoke({
    agentRole: "engineer",
    task: "implement",
    projectDir,
    modelAlias: "review",
    dockerExec: completedExec(invokeCalls),
  });
  assert.equal(invoked.status, "complete");
  const invokeArgv = invokeCalls[0]!;
  const modelIndex = invokeArgv.indexOf("claude-opus-test");
  assert.deepEqual(invokeArgv.slice(modelIndex, modelIndex + 3), ["claude-opus-test", "--effort", "low"]);
  const invokeManifest = JSON.parse(readFileSync(join(taskDir(invoked.runId, invoked.taskId), "manifest.json"), "utf8")) as TaskManifest;
  assert.equal(invokeManifest.model?.effort, "low");
  assert.equal(modelEvent(invoked.taskId)?.effort, "low");

  const pipelineCalls: string[][] = [];
  const wf = workflow(false, "review");
  const { runId } = startRun({ workflow: wf, title: "fg807-pipeline", inputs: { brief: "test" }, projectDir, modelProfile: "subscription" });
  const wave = await runNext({ runId, workflow: wf, dockerExec: completedExec(pipelineCalls) });
  assert.deepEqual(wave.completedSteps, ["build"]);
  const pipelineTask = tasksForRun(runId).find((task) => task.phase === "build") ?? tasksForRun(runId).find((task) => task.agentRole === "engineer");
  assert.ok(pipelineTask, "pipeline task was created");
  const pipelineArgv = pipelineCalls[0]!;
  const pipelineModelIndex = pipelineArgv.indexOf("claude-opus-test");
  assert.deepEqual(pipelineArgv.slice(pipelineModelIndex, pipelineModelIndex + 3), ["claude-opus-test", "--effort", "low"]);
  const pipelineManifest = JSON.parse(readFileSync(join(taskDir(runId, pipelineTask!.id), "manifest.json"), "utf8")) as TaskManifest;
  assert.equal(pipelineManifest.model?.effort, "low");
  assert.equal(modelEvent(pipelineTask!.id)?.effort, "low");

  const unsetCalls: string[][] = [];
  const unset = await invoke({ agentRole: "engineer", task: "default work", projectDir, modelAlias: "default", dockerExec: completedExec(unsetCalls) });
  assert.equal(unset.status, "complete");
  assert.ok(!unsetCalls[0]!.includes("--effort"), "unset effort adds no argv flag");
  const unsetManifest = JSON.parse(readFileSync(join(taskDir(unset.runId, unset.taskId), "manifest.json"), "utf8")) as TaskManifest;
  assert.equal(unsetManifest.model?.effort, undefined, "unset effort is omitted from the manifest");
  assert.equal(modelEvent(unset.taskId)?.effort, undefined, "unset effort is omitted from the event");
});

test("FG-807: a feature-style red dispatch resolves review, falls back to default without refusal, and preserves triage fast-orchestrator", async () => {
  const wf = workflow(true);
  for (const scenario of [
    { review: true, expectedModel: "claude-opus-test", expectedEffort: "low" },
    { review: false, expectedModel: "claude-sonnet-test", expectedEffort: undefined },
  ]) {
    writePolicy(scenario.review);
    const calls: string[][] = [];
    const { runId } = startRun({ workflow: wf, title: `fg807-red-${scenario.review}`, inputs: { brief: "test" }, projectDir, modelProfile: "subscription" });
    await runNext({ runId, workflow: wf, dockerExec: completedExec(calls) });
    await runNext({ runId, workflow: wf, dockerExec: completedExec(calls) });
    const red = tasksForRun(runId).find((task) => task.agentRole === "red-wide");
    assert.ok(red, "red was dispatched after the feature step");
    assert.equal(red!.status, "complete", "role-derived default fallback must not become activity_unmapped refusal");
    const event = modelEvent(red!.id)!;
    assert.equal(event.model, scenario.expectedModel);
    assert.equal(event.effort, scenario.expectedEffort);
    assert.ok(!eventsForTask(red!.id).some((e) => e.eventType === "model.profile_unavailable"), "red dispatch has no activity_unmapped refusal");
  }

  const triageCalls: string[][] = [];
  const triage = await invoke({ agentRole: "engineer", task: "triage", projectDir, modelAlias: "fast-orchestrator", dockerExec: completedExec(triageCalls) });
  assert.equal(triage.status, "complete");
  assert.ok(triageCalls[0]!.includes("claude-haiku-test"), "fast-orchestrator remains a valid triage mapping");
});
