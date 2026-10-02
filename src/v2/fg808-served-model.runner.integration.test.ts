// FG-808 runner-side regression coverage.  The first FG-808 integration test
// drives invoke(); this file drives the workflow runner, including its failure
// arm, with records shaped from the captured Claude stream fixture.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { eventsForTask } from "../store/events.js";
import { getRun } from "../store/runs.js";
import { tasksForRun } from "../store/tasks.js";
import { taskDir } from "../util/paths.js";
import { readTaskManifest } from "./task-manifest.js";
import type { Workflow } from "./schema.js";
import { assessLens } from "./review-discovery.js";
import { insertReview, mergeLensOutcomesByShard, recordShardPlan, type ShardDerivation } from "../store/reviews.js";
import { insertRun } from "../store/runs.js";
import { registerReview } from "../cli/commands/review.js";
import { shardPlanDigest } from "./review-shards.js";
import { REVIEW_DIFF_RENDERING_ID } from "./review-diff.js";
import type { Run } from "../types/index.js";

const REQUESTED = "claude-opus-5-5";
const RUNTIME = "fg808-runner-claude";

function ensureRuntime(): void {
  const path = join(process.env.FORGE_HOME!, "runtimes", `${RUNTIME}.yml`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `name: ${RUNTIME}
description: FG-808 real-shaped stream fixture runtime
runtime_kind: claude-code
log_format: claude-stream-json
image: test-image:latest
models:
  default: ${REQUESTED}
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: claude
  args: ["-p"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

/** Preserve the captured event fields and replace only the per-request facts. */
function realShapedStream(rows: Array<{ model: string; output: number }>): string {
  const fixture = readFileSync(join(process.cwd(), "src/store/__fixtures__/real-claude-stream.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
  const init = fixture[0]!;
  const assistant = fixture[1]!;
  const delta = fixture[2]!;
  const lines: Record<string, any>[] = [init];
  rows.forEach(({ model, output }, index) => {
    lines.push({
      ...assistant,
      request_id: `req_${index}`,
      message: { ...assistant.message, id: `msg_bdrk_fg808_${index}`, model },
    });
    lines.push({ ...delta, event: { ...delta.event, usage: { ...delta.event.usage, output_tokens: output } } });
  });
  lines.push({ type: "result", subtype: "success", is_error: false, session_id: init.session_id });
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function streamExec(rows: Array<{ model: string; output: number }>, exitCode = 0): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    mkdirSync(dirname(stdoutPath), { recursive: true });
    writeFileSync(stdoutPath, realShapedStream(rows));
    writeFileSync(stderrPath, "");
    if (exitCode === 0) writeFileSync(join(dirname(stdoutPath), "result.json"), JSON.stringify({ status: "complete" }));
    return exitCode;
  };
}

const WORKFLOW: Workflow = {
  name: "fg808-runner-workflow", description: "FG-808 runner served-model coverage", review_mode: "legacy_verdict", inputs: [],
  steps: [{ id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: RUNTIME, reds: [] }],
};

async function dispatchThroughRunner(rows: Array<{ model: string; output: number }>, exitCode = 0) {
  ensureRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = join(tmpdir(), `forge-fg808-runner-${Date.now()}-${Math.random()}`);
  mkdirSync(projectDir, { recursive: true });
  const { runId } = startRun({ workflow: WORKFLOW, title: "FG-808 runner", inputs: {}, projectDir });
  await runNext({ runId, workflow: WORKFLOW, dockerExec: streamExec(rows, exitCode) });
  const task = tasksForRun(runId).find((candidate) => candidate.phase === "build")!;
  return { runId, task, projectDir };
}

test("FG-808: runNext classifies real-shaped same, switched, mixed and even streams without changing task completion", async () => {
  const cases = [
    { name: "same", rows: [{ model: "us.anthropic.claude-opus-5-5", output: 100 }], classification: "same", events: 0 },
    { name: "switched", rows: [{ model: REQUESTED, output: 10 }, { model: "claude-opus-4-1", output: 90 }], classification: "switched", events: 1 },
    { name: "mixed", rows: [{ model: REQUESTED, output: 90 }, { model: "claude-haiku-4-5", output: 10 }], classification: "mixed", events: 1 },
    { name: "even", rows: [{ model: REQUESTED, output: 50 }, { model: "claude-opus-4-1", output: 50 }], classification: "switched", events: 1 },
    { name: "zero-usage", rows: [], classification: undefined, events: 0 },
  ] as const;
  let baselineTaskStatus: string | undefined;
  let baselineRunStatus: string | undefined;
  for (const scenario of cases) {
    const { runId, task, projectDir } = await dispatchThroughRunner([...scenario.rows]);
    try {
      // The minimal engineer fixture stops at the same validation gate for every
      // case.  The important invariant is parity with the same-model dispatch,
      // rather than assuming a particular workflow's terminal gate policy.
      if (baselineTaskStatus === undefined) baselineTaskStatus = task.status;
      if (baselineRunStatus === undefined) baselineRunStatus = getRun(runId)?.status;
      assert.equal(task.status, baselineTaskStatus, `${scenario.name}: model telemetry must not alter task/gate status`);
      assert.equal(getRun(runId)?.status, baselineRunStatus, `${scenario.name}: model telemetry must not alter run status`);
      assert.equal(readTaskManifest(taskDir(runId, task.id))?.servedModel?.classification, scenario.classification);
      assert.equal(eventsForTask(task.id).filter((event) => event.eventType === "task.model_mismatch").length, scenario.events);
    } finally { rmSync(projectDir, { recursive: true, force: true }); }
  }
});

test("FG-808: runNext records a switched check once after usage capture even when the container crashes", async () => {
  const { runId, task, projectDir } = await dispatchThroughRunner([{ model: "claude-opus-4-1", output: 100 }], 1);
  try {
    assert.equal(task.status, "failed", "fixture must take the container_crash arm");
    assert.equal(readTaskManifest(taskDir(runId, task.id))?.servedModel?.classification, "switched");
    assert.equal(eventsForTask(task.id).filter((event) => event.eventType === "task.model_mismatch").length, 1);
  } finally { rmSync(projectDir, { recursive: true, force: true }); }
});

test("FG-808: an evidence-led red shard retains switched-model provenance in review show without raising a gate", async () => {
  const run: Run = { id: "fg808-review-run", workflow: "review", title: "FG-808", status: "active", createdAt: "2026-10-02T00:00:00Z", reviewMode: "evidence_led" };
  insertRun(run);
  const derivation: ShardDerivation = { baseSha: "base", candidateSha: "candidate", renderingId: REVIEW_DIFF_RENDERING_ID, budget: 1000, unit: "chars", envelopes: {}, budgetValidatedRuntime: "test", scopesDigest: "scope" };
  const digest = shardPlanDigest(derivation);
  insertReview({ id: "fg808-review", runId: run.id, ticketId: "FG-808", reviewMode: "evidence_led", baseSha: "base", candidateSha: "candidate", contractConfirmedSha: "candidate", state: "discovering", contract: { threat_model: "served model audit", protected_invariants: ["model telemetry is informational"], acceptance_refs: ["FG-808"], risk_lenses: ["security"], non_goals: [], lens_scopes: { security: ["src/"] } } });
  recordShardPlan("fg808-review", { derivation, digest, fanoutWidth: 1, lenses: [{ lens: "security", shards: [{ index: 1, of: 1, paths: ["src/v2/runNext.ts"], chars: 1 }] }], skipped: [] });
  const outcome = assessLens({ lens: "security", role: "red-security", dispatched: true, taskId: "red-shard", shard: { index: 1, of: 1 }, derivationDigest: digest, result: { outcome: "pass", findings: [] }, servedModel: { requested: REQUESTED, classification: "switched", servedModels: [{ model: "claude-opus-4-1", requestIds: ["req_9"], count: 1, outputTokens: 100, share: 1 }] } });
  mergeLensOutcomesByShard("fg808-review", [outcome]);
  const out: string[] = [];
  const program = new Command();
  registerReview(program);
  mock.method(console, "log", (...args: unknown[]) => out.push(args.map(String).join(" ")));
  try { await program.parseAsync(["review", "show", "fg808-review"], { from: "user" }); } finally { mock.restoreAll(); }
  assert.match(out.join("\n"), /shard 1 of 1 — delivered pass.*model: requested claude-opus-5-5, served claude-opus-4-1 ×1 \(100%\) \(switched\)/);
  assert.equal(getRun(run.id)?.status, "active", "a model mismatch alone never raises or settles a gate");
});
