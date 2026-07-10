// FG-519 end-to-end: resolvePhasePrimary (latest COMPLETE parent-less row) is the
// ONE canonical phase-primary rule, consumed by deriveUpstream, computeReadyQueue,
// and the fanout upstream read. The engineer's unit tests (inputs.test.ts,
// ready-queue.test.ts) exercise each reader in isolation. These tests close the
// gaps between those unit readers and the LIVE pipeline:
//
//   (A) Headline, full dispatch composition: a phase healed to [complete older,
//       failed newer] by the REAL heal machinery (finalizeOrphanedPrimaries),
//       then the DOWNSTREAM step dispatched via real runNext — its task package /
//       on-disk container artifact (package.md) must carry the COMPLETE row's
//       result content, never the failed orphan's undefined. deriveUpstream is
//       driven through runNext here, not called directly.
//   (B) Cross-site agreement: on ONE shared mixed task universe ([complete older,
//       failed newer, + a red child as noise]) the three formerly-divergent rules
//       (resolvePhasePrimary, deriveUpstream, computeReadyQueue dep-satisfaction)
//       now pick the SAME complete row — the FG-519 thesis, pinned.
//   (C) FG-475 regression: a phase with [complete + failed-newer + pending
//       on_reject recovery] still re-admits and DISPATCHES its recovery task
//       through the real ready queue → runNext, the carve-out surviving under the
//       new helper (previously the exception guarded `hasCompletePrimary`).
//
// Every setup uses MIXED shapes (the standing FG-475 lesson), never single/empty.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun, getTask, insertTask } from "../store/tasks.js";
import { finalizeOrphanedPrimaries } from "./reconcile.js";
import { computeReadyQueue, resolvePhasePrimary } from "./ready-queue.js";
import { deriveUpstream } from "./inputs.js";
import { taskDir, RUNS_DIR } from "../util/paths.js";
import type { Workflow, Step } from "./schema.js";
import type { Task } from "../types/index.js";

// ── shared harness ────────────────────────────────────────────────────────────

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "claude.yml");
  if (existsSync(runtimePath)) return;
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: claude
description: test stub runtime
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
`,
  );
}

type PrefixResult = { prefix: string; result: unknown };

// Routing exec keyed by container --name (== forge-<taskId>). Records every task
// id it was invoked for so a test can prove a specific row was actually dispatched.
function makeRoutingExec(routes: PrefixResult[], invoked: string[]): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const fullName = nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "";
    const taskId = fullName.replace(/^forge-/, "");
    invoked.push(taskId);

    const route = routes.find((r) => taskId.startsWith(r.prefix));
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify(route ? route.result : { status: "complete" }),
    );
    return 0;
  };
}

function mkTask(opts: {
  id: string;
  runId: string;
  phase: string;
  status: Task["status"];
  parentId?: string;
  agentRole?: string;
  createdAt: string;
  inputs?: Record<string, unknown>;
  result?: unknown;
}): Task {
  return {
    id: opts.id,
    runId: opts.runId,
    parentId: opts.parentId,
    phase: opts.phase,
    agentRole: opts.agentRole ?? "engineer",
    status: opts.status,
    taskPackage: {
      taskId: opts.id,
      runId: opts.runId,
      phase: opts.phase,
      role: opts.agentRole ?? "engineer",
      inputs: opts.inputs ?? {},
      composedSystemPrompt: "PROMPT",
    },
    result: opts.result,
    createdAt: opts.createdAt,
  };
}

function mkStep(id: string, depends_on: string[] = []): Step {
  return { id, agent: `${id}-agent`, gate: "auto", manual: false, depends_on, runtime: "claude", reds: [] };
}

// ── (A) headline: real heal → real downstream dispatch carries the COMPLETE row ──

const BUILD_VERIFY_WF: Workflow = {
  name: "fg519-build-verify",
  description: "FG-519 E2E: two-step linear, downstream reads the healed phase",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "verify", agent: "test-engineer", gate: "auto", manual: false, depends_on: ["build"], runtime: "claude", reds: [] },
  ],
};

test("FG-519 E2E: after a real duplicate-primary heal ([complete older, failed newer]), the downstream step's task package carries the COMPLETE row's result — not the failed orphan's undefined", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();

  const BUILD_MARKER = "BUILD-REAL-OUTPUT-7f3a91";
  const invoked: string[] = [];
  const exec = makeRoutingExec(
    [
      { prefix: "task-build-", result: { status: "complete", buildMarker: BUILD_MARKER, plan: ["s1", "s2"] } },
      { prefix: "task-verify-", result: { status: "complete" } },
    ],
    invoked,
  );

  const { runId } = startRun({
    workflow: BUILD_VERIFY_WF,
    title: "fg519 headline e2e",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  // Wave 1: real dispatch → build completes. The COMPLETE primary and its
  // result.json are produced by the real pipeline, not fabricated.
  const wave1 = await runNext({ runId, workflow: BUILD_VERIFY_WF, dockerExec: exec });
  assert.deepEqual(wave1.completedSteps, ["build"], "build must complete on wave 1");

  const buildComplete = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined && t.status === "complete");
  assert.ok(buildComplete, "a complete build primary must exist");

  // Inject the duplicate-primary artifact: a second, NEWER pending primary in the
  // same phase. This is the row a heal/reconcile pass finds after a double-dispatch.
  insertTask(
    mkTask({
      id: "task-build-DUPLICATE",
      runId,
      phase: "build",
      status: "pending",
      createdAt: "2999-01-01T00:00:00.000Z", // guaranteed newer than the real build row
    }),
  );

  // Real heal machinery: finalizeOrphanedPrimaries marks the never-run duplicate
  // FAILED (it never wrote result.json). Phase is now [complete older, failed newer]
  // — the exact healed-duplicate shape FG-519's ticket describes.
  const changes = finalizeOrphanedPrimaries(runId);
  assert.ok(
    changes.some((c) => c.taskId === "task-build-DUPLICATE" && c.to === "failed"),
    "the real heal must fail the duplicate pending primary",
  );
  const dup = getTask("task-build-DUPLICATE")!;
  assert.equal(dup.status, "failed", "duplicate must be healed to failed");
  assert.ok(dup.createdAt > buildComplete.createdAt, "duplicate must be the NEWER row (the status-blind pop() trap)");

  // Wave 2: real dispatch of the downstream step over the healed phase.
  const wave2 = await runNext({ runId, workflow: BUILD_VERIFY_WF, dockerExec: exec });
  assert.deepEqual(wave2.dispatchedSteps, ["verify"], "verify must dispatch; build must NOT be re-admitted");

  const verifyTask = tasksForRun(runId).find((t) => t.phase === "verify" && t.parentId === undefined);
  assert.ok(verifyTask, "verify task must exist");
  assert.ok(invoked.some((id) => id.startsWith("task-verify-")), "a container must have been dispatched for verify");

  // The composed inputs the downstream agent received must name the COMPLETE row
  // and carry ITS result content — never the failed newer orphan (undefined).
  const upstream = (verifyTask!.taskPackage.inputs as Record<string, unknown>)["upstream"] as Array<{
    phase: string;
    taskId: string;
    result: { status?: string; buildMarker?: string } | undefined;
  }>;
  assert.ok(Array.isArray(upstream), "inputs.upstream must be present");
  assert.equal(upstream.length, 1, "verify sees exactly one upstream entry (its single dep)");
  assert.equal(upstream[0]!.phase, "build");
  assert.equal(upstream[0]!.taskId, buildComplete.id, "upstream must name the COMPLETE build row, not the failed newer duplicate");
  assert.notEqual(upstream[0]!.result, undefined, "FG-519: downstream result must not be undefined");
  assert.equal(upstream[0]!.result!.buildMarker, BUILD_MARKER, "downstream must receive the complete row's ACTUAL result content");

  // End-to-end proof the value reached the container artifact on disk: the
  // rendered package.md (mounted into /task) contains the build marker.
  const pkgPath = join(taskDir(runId, verifyTask!.id), "package.md");
  assert.ok(existsSync(pkgPath), "verify package.md must be written to the task dir");
  const pkg = readFileSync(pkgPath, "utf8");
  assert.match(pkg, new RegExp(BUILD_MARKER), "the container-facing package.md must carry the COMPLETE row's result content");
});

// ── (B) cross-site agreement on ONE mixed universe ──────────────────────────────

test("FG-519: the three consumers agree on the same COMPLETE row for one mixed phase ([complete older, failed newer, + red child noise])", () => {
  const runId = "run-fg519-crosssite";
  const runDir = join(RUNS_DIR, runId);

  // The complete row is the ONLY one with a result.json on disk.
  const completeDir = join(runDir, "t-build-real");
  mkdirSync(completeDir, { recursive: true });
  writeFileSync(join(completeDir, "result.json"), JSON.stringify({ status: "complete", marker: "REAL" }));

  const tasks: Task[] = [
    mkTask({ id: "t-build-real", runId, phase: "build", status: "complete", createdAt: "2026-06-03T16:00:00.000Z", agentRole: "engineer" }),
    // failed NEWER — the row a status-blind pop() would have picked.
    mkTask({ id: "t-build-heal", runId, phase: "build", status: "failed", createdAt: "2026-06-03T17:00:00.000Z" }),
    // red child (parent-tagged) — must be ignored by every consumer.
    mkTask({ id: "t-build-red", runId, phase: "build", parentId: "t-build-real", status: "complete", createdAt: "2026-06-03T18:00:00.000Z", agentRole: "red-wide" }),
  ];

  // Consumer 1: the canonical helper directly.
  const primary = resolvePhasePrimary(tasks, "build");
  assert.equal(primary?.id, "t-build-real", "resolvePhasePrimary → the complete parent-less row");

  // Consumer 2: deriveUpstream (reads result.json off disk).
  const upstream = deriveUpstream({ step: mkStep("verify", ["build"]), allTasks: tasks, runDir });
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0]!.taskId, "t-build-real", "deriveUpstream → the SAME complete row");
  assert.deepEqual(upstream[0]!.result, { status: "complete", marker: "REAL" }, "and its real result content");

  // Consumer 3: computeReadyQueue dep-satisfaction + self-close.
  const wf: Workflow = {
    name: "fg519-crosssite",
    description: "cross-site agreement",
    inputs: [],
    steps: [mkStep("build"), mkStep("verify", ["build"])],
  };
  const ready = computeReadyQueue(wf, tasks);
  assert.deepEqual(ready.map((s) => s.id), ["verify"], "build closes off the complete row; verify becomes ready off it — not re-admitted, not blocked by the failed newer row");

  // The FG-519 thesis: all three now pick the identical row.
  assert.equal(primary!.id, upstream[0]!.taskId, "resolvePhasePrimary and deriveUpstream must agree on the phase-authoritative row");
});

// ── (C) FG-475 recovery regression through the real ready queue → dispatch ───────

const INVESTIGATE_AUDIT_WF: Workflow = {
  name: "fg519-recovery",
  description: "FG-519: on_reject recovery re-admission under the new helper",
  inputs: [],
  steps: [
    { id: "investigate", agent: "investigator", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "audit", agent: "auditor", gate: "human", manual: false, depends_on: ["investigate"], on_reject: "investigate", runtime: "claude", reds: [] },
  ],
};

test("FG-519 regression: a live pending on_reject recovery task in a [complete + failed-newer + pending-recovery] phase is still DISPATCHED through the real ready queue (FG-475 carve-out survives the helper)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();

  const { runId } = startRun({
    workflow: INVESTIGATE_AUDIT_WF,
    title: "fg519 recovery regression",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  // investigate: a complete primary AND a healed-duplicate failed-newer row.
  insertTask(mkTask({ id: "t-inv-complete", runId, phase: "investigate", status: "complete", createdAt: "2026-07-01T10:00:00.000Z", agentRole: "investigator" }));
  insertTask(mkTask({ id: "t-inv-healed", runId, phase: "investigate", status: "failed", createdAt: "2026-07-01T11:00:00.000Z", agentRole: "investigator" }));
  // audit: a rejected (failed) primary — the reject that fired on_reject back to investigate.
  insertTask(mkTask({ id: "t-audit-rejected", runId, phase: "audit", status: "failed", createdAt: "2026-07-01T12:00:00.000Z", agentRole: "auditor" }));
  // The live recovery task gate.ts's reject branch minted: parent-tagged, carrying
  // rejectedTaskId, landing in the rejected primary's OWN phase (self-referencing on_reject).
  insertTask(
    mkTask({
      id: "t-inv-recovery",
      runId,
      phase: "investigate",
      parentId: "t-audit-rejected",
      status: "pending",
      createdAt: "2026-07-01T13:00:00.000Z",
      agentRole: "investigator",
      inputs: { rejectedTaskId: "t-audit-rejected", rejectedRationale: "needs another pass" },
    }),
  );

  const invoked: string[] = [];
  const exec = makeRoutingExec([{ prefix: "task-", result: { status: "complete" } }], invoked);
  await runNext({ runId, workflow: INVESTIGATE_AUDIT_WF, dockerExec: exec });

  // The carve-out: despite investigate having a COMPLETE primary, the live recovery
  // row re-admitted the phase and was actually dispatched and run.
  const recovery = getTask("t-inv-recovery")!;
  assert.equal(recovery.status, "complete", "the pending on_reject recovery task must be dispatched and completed — the FG-475 carve-out must survive resolvePhasePrimary");
  assert.ok(invoked.includes("t-inv-recovery"), "a container must have been dispatched for the recovery task specifically");

  // The other rows in the mixed phase are untouched; audit (only a failed primary,
  // no complete, no pending) is not re-dispatched.
  assert.equal(getTask("t-inv-complete")!.status, "complete", "the complete primary is unchanged");
  assert.equal(getTask("t-inv-healed")!.status, "failed", "the healed-duplicate failed row is unchanged");
  assert.equal(getTask("t-audit-rejected")!.status, "failed", "audit's rejected primary must not be re-dispatched");
  assert.ok(!invoked.includes("t-audit-rejected"), "no container for the rejected audit row");
});
