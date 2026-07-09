import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun, getRun, updateRunStatus } from "../store/runs.js";
import { insertTask, getTask, tasksForRun } from "../store/tasks.js";
import { eventsForTask, eventsForRun, logEvent } from "../store/events.js";
import { taskDir } from "../util/paths.js";
import { reconcileRun, reconcileRuns, defaultReconcileWriters, defaultContainerReap, defaultContainerExitInfo, attachedExitEvidence } from "./reconcile.js";
import type { ReconcileWriters } from "./reconcile.js";
import type { OrphanEvidence } from "./failure-kind.js";
import { getContainerCausalEvidenceFromEvents } from "./failure-kind.js";
import { orphanRecoveryMessage, describeContainerEvidence, missingContainerEvidence } from "../cli/commands/show.js";
import { performReDrive } from "../cli/commands/recover.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = { id: "run-rec", workflow: "invoke", title: "rec", status: "active", createdAt: "2026-05-30T00:00:00Z" };

function mkTask(id: string, o: Partial<Task> = {}): Task {
  return { id, runId: o.runId ?? RUN.id, phase: "task", agentRole: "engineer", status: o.status ?? "running",
    taskPackage: { taskId: id, runId: o.runId ?? RUN.id, phase: "task", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-30T00:00:00Z", startedAt: "2026-05-30T00:00:01Z", ...o };
}
// Insert a CONTAINERIZED task (emits container.started — the signal reconcile
// gates on). Most agent tasks; not session/manual tasks.
function insertContainerized(t: Task) {
  insertTask(t);
  logEvent("container.started", { runId: t.runId, taskId: t.id, payload: { containerName: `forge-${t.id}` } });
}
const ALIVE = () => true;
const GONE = () => false;

// FG-455 fixtures: a pi-jsonl clean completion (mirrors fg337-inferred-result's
// builder) and a git-backed worktree with an uncommitted change.
function piCleanEndStdout(text: string): string {
  return (
    JSON.stringify({ type: "agent_start" }) + "\n" +
    JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn", content: text }] }) + "\n"
  );
}

function writePiManifest(dir: string): void {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    runtime: { name: "pi-stub", kind: "pi", logFormat: "pi-jsonl", promptStrategy: "message-arg", authStrategy: "env-provider-api-key" },
  }));
}

function makeDirtyGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-rec-worktree-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "changed-file.txt"), "uncommitted work\n");
  return dir;
}

beforeEach(() => { db = makeInMemoryDb(); prev = setDbForTest(db); insertRun(RUN); });
afterEach(() => { setDbForTest(prev as DatabaseInstance); db.close(); });

test("reconcile: container still running → task untouched", () => {
  insertContainerized(mkTask("t-live", { status: "running" }));
  const r = reconcileRun(RUN.id, ALIVE);
  assert.equal(r.taskChanges.length, 0);
  assert.equal(getTask("t-live")!.status, "running");
});

test("reconcile: container gone, NO result → task failed with failure_kind=orphaned + reconciled event", () => {
  insertContainerized(mkTask("t-orphan", { status: "running" }));
  const r = reconcileRun(RUN.id, GONE);
  assert.deepEqual(r.taskChanges, [{ taskId: "t-orphan", from: "running", to: "failed", reason: "container_gone_no_result" }]);
  assert.equal(getTask("t-orphan")!.status, "failed");
  const types = eventsForTask("t-orphan").map((e) => e.eventType);
  assert.ok(types.includes("task.failed"), "emits the normal terminal event");
  assert.ok(types.includes("task.reconciled"), "emits the reconciliation audit event");
  const failed = eventsForTask("t-orphan").find((e) => e.eventType === "task.failed")!;
  assert.equal((failed.payload as Record<string, unknown>).failure_kind, "orphaned");
});

test("reconcile: container gone WITH a valid result → finalized as complete (lost DB write recovered)", () => {
  const gitDir = makeDirtyGitRepo();
  try {
    insertContainerized(mkTask("t-result", { status: "running", worktreePath: gitDir }));
    const dir = taskDir(RUN.id, "t-result");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", output: "done" }));
    const r = reconcileRun(RUN.id, GONE);
    assert.deepEqual(r.taskChanges, [{ taskId: "t-result", from: "running", to: "complete", reason: "container_gone_result_present" }]);
    const t = getTask("t-result")!;
    assert.equal(t.status, "complete");
    assert.deepEqual(t.result, { status: "complete", output: "done" });
    const types = eventsForTask("t-result").map((e) => e.eventType);
    assert.ok(types.includes("task.completed") && types.includes("task.reconciled"));

    // FG-455 p1 review: the valid-result outcome is one of the four container-gone
    // outcomes — it must carry the same accurately-gathered evidence tuple as the
    // other three, not a hardcoded worktreePathChecked: null / changedFiles: [].
    const reconciled = eventsForTask("t-result").find((e) => e.eventType === "task.reconciled")!;
    const evidence = (reconciled.payload as Record<string, unknown>).evidence as OrphanEvidence;
    assert.equal(evidence.containerName, "forge-t-result");
    assert.equal(evidence.containerLiveness, "gone");
    assert.equal(evidence.resultState, "valid");
    assert.equal(evidence.worktreePathChecked, gitDir, "the task's real worktree_path is checked, not hardcoded null");
    assert.deepEqual(evidence.changedFiles, ["?? changed-file.txt"], "changed files are actually computed, not hardcoded []");
    assert.equal(evidence.source, "worktree");
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
});

// ----- FG-492 finding 3: reap a clean-exit container reconcile discovers -----
//
// A task container that exited 0 leaks permanently if the forge process dies
// before docker-exec.ts's own close handler (captureContainerCausalEvidence +
// finalizeContainerRetention) can reap it — spawn.ts no longer runs task
// containers with --rm. `forge ops reap-containers` only ever scans FAILED
// tasks, so a task reconcile finalizes to COMPLETE here would never be swept
// by it. reconcile now mirrors docker-exec.ts's own shouldRetainContainer
// policy: reap only a CONFIRMED clean exit (0); leave a genuine failure
// retained for `forge show` / `forge ops reap-containers` diagnosis, and never
// guess when the exit code is unknown.

test("FG-492 finding 3: container gone WITH a valid result AND a confirmed clean exit (0) → the now-stopped container is reaped", () => {
  const gitDir = makeDirtyGitRepo();
  try {
    const taskId = "t-clean-exit-reaped";
    insertContainerized(mkTask(taskId, { status: "running", worktreePath: gitDir }));
    const dir = taskDir(RUN.id, taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", output: "done" }));
    const exitInfo = () => ({ exitCode: 0 });
    const reaped: string[] = [];
    const reap = (name: string): "killed" => { reaped.push(name); return "killed"; };

    const r = reconcileRun(RUN.id, GONE, reap, exitInfo);

    assert.deepEqual(r.taskChanges, [{ taskId, from: "running", to: "complete", reason: "container_gone_result_present" }]);
    assert.equal(getTask(taskId)!.status, "complete");
    assert.deepEqual(reaped, [`forge-${taskId}`], "a confirmed clean exit is reaped, matching docker-exec.ts's own shouldRetainContainer policy");
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
});

test("FG-492 finding 3: container gone, no result, confirmed FAILURE exit → NOT reaped (retained for diagnosis)", () => {
  const taskId = "t-failed-exit-retained";
  insertContainerized(mkTask(taskId, { status: "running" })); // clean worktree — no changed files → ordinary orphaned
  const exitInfo = () => ({ exitCode: 1 });
  const reaped: string[] = [];
  const reap = (name: string): "killed" => { reaped.push(name); return "killed"; };

  const r = reconcileRun(RUN.id, GONE, reap, exitInfo);

  assert.deepEqual(r.taskChanges, [{ taskId, from: "running", to: "failed", reason: "container_gone_no_result" }]);
  assert.deepEqual(reaped, [], "a genuine failure stays retained — never reaped just because reconcile observed it");
});

test("FG-492 finding 3: container gone, exit code UNKNOWN (docker inspect ambiguous/failed) → NOT reaped (never guess)", () => {
  const taskId = "t-unknown-exit-retained";
  insertContainerized(mkTask(taskId, { status: "running" }));
  const exitInfo = () => ({}); // unknown — no exitCode
  const reaped: string[] = [];
  const reap = (name: string): "killed" => { reaped.push(name); return "killed"; };

  reconcileRun(RUN.id, GONE, reap, exitInfo);

  assert.deepEqual(reaped, [], "an unconfirmed exit code must never be treated as a clean exit");
});

test("FG-492 finding 3: FORGE_CONTAINER_RETENTION=off reaps even a confirmed FAILURE exit, matching docker-exec.ts's escape hatch", () => {
  process.env.FORGE_CONTAINER_RETENTION = "off";
  try {
    const taskId = "t-retention-off-reaped";
    insertContainerized(mkTask(taskId, { status: "running" }));
    const exitInfo = () => ({ exitCode: 137 });
    const reaped: string[] = [];
    const reap = (name: string): "killed" => { reaped.push(name); return "killed"; };

    reconcileRun(RUN.id, GONE, reap, exitInfo);

    assert.deepEqual(reaped, [`forge-${taskId}`]);
  } finally {
    delete process.env.FORGE_CONTAINER_RETENTION;
  }
});

// ----- FG-455: don't discard persisted work on an empty/absent result.json -----

test("FG-455: container gone, empty result, but a recoverable stdout result (FG-337 synthesis) → task COMPLETE, not orphaned", () => {
  const taskId = "t-stdout-recoverable";
  insertContainerized(mkTask(taskId, { status: "running", agentRole: "research-specialist" }));
  const dir = taskDir(RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writePiManifest(dir);
  const text = "Recovered narrative output from stdout.";
  writeFileSync(join(dir, "container.stdout.log"), piCleanEndStdout(text));
  // result.json intentionally absent — the wrapper's empty seed was never filled in.

  const r = reconcileRun(RUN.id, GONE);
  assert.deepEqual(r.taskChanges, [{ taskId, from: "running", to: "complete", reason: "container_gone_result_recovered_from_stdout" }]);

  const t = getTask(taskId)!;
  assert.equal(t.status, "complete");
  assert.deepEqual(t.result, { contract: "inferred", summary: text, status: "complete" });

  const types = eventsForTask(taskId).map((e) => e.eventType);
  assert.ok(types.includes("task.completed"), "must complete, not fail");
  assert.ok(!types.includes("task.failed"), "must NOT be reported as failed");
  assert.ok(types.includes("task.reconciled"));

  // The recovered result is persisted to disk too, mirroring the FG-337 dispatch-time paths.
  const onDisk = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as Record<string, unknown>;
  assert.equal(onDisk.contract, "inferred");
  assert.equal(onDisk.summary, text);

  // FG-455 review finding 2: the recovered-complete outcome must carry the same
  // evidence tuple as the other two container-gone outcomes.
  const reconciled = eventsForTask(taskId).find((e) => e.eventType === "task.reconciled")!;
  const evidence = (reconciled.payload as Record<string, unknown>).evidence as OrphanEvidence;
  assert.equal(evidence.containerName, `forge-${taskId}`);
  assert.equal(evidence.containerLiveness, "gone");
  assert.equal(evidence.recoverableStdoutResult, true);
  assert.equal(evidence.resultWriteFailed, undefined, "disk write succeeded — no failure noted");
});

test("FG-455 review finding1: recovered stdout result, but the result.json write throws (dir in the way) → task still COMPLETES from the in-memory result, reconcileRun does not throw, and evidence records resultWriteFailed", () => {
  const taskId = "t-write-throws";
  insertContainerized(mkTask(taskId, { status: "running", agentRole: "research-specialist" }));
  const dir = taskDir(RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writePiManifest(dir);
  const text = "Recovered narrative output from stdout.";
  writeFileSync(join(dir, "container.stdout.log"), piCleanEndStdout(text));
  // result.json is a directory — writeFileSync throws EISDIR when reconcile
  // tries to persist the recovered result, same TOCTOU stand-in as finding1's
  // read-side test above.
  mkdirSync(join(dir, "result.json"), { recursive: true });

  let r: ReturnType<typeof reconcileRun> | undefined;
  assert.doesNotThrow(() => { r = reconcileRun(RUN.id, GONE); });
  assert.deepEqual(r!.taskChanges, [{ taskId, from: "running", to: "complete", reason: "container_gone_result_recovered_from_stdout" }]);

  const t = getTask(taskId)!;
  assert.equal(t.status, "complete", "completes from the in-memory recovered result despite the disk write failing");
  assert.deepEqual(t.result, { contract: "inferred", summary: text, status: "complete" });

  const types = eventsForTask(taskId).map((e) => e.eventType);
  assert.ok(types.includes("task.completed"), "must complete, not fail");
  assert.ok(!types.includes("task.failed"), "must NOT be reported as failed");

  const reconciled = eventsForTask(taskId).find((e) => e.eventType === "task.reconciled")!;
  const evidence = (reconciled.payload as Record<string, unknown>).evidence as OrphanEvidence;
  assert.equal(evidence.recoverableStdoutResult, true);
  assert.equal(evidence.resultWriteFailed, true, "the disk-write failure is recorded in evidence, not swallowed silently");
});

test("FG-455: container gone, empty result, no recoverable stdout, but a dirty worktree → failure_kind=orphaned_work_may_persist (work preserved, not discarded)", () => {
  const gitDir = makeDirtyGitRepo();
  try {
    const taskId = "t-worktree-dirty";
    insertContainerized(mkTask(taskId, { status: "running", worktreePath: gitDir }));
    // No manifest / stdout at all — simulates the wrapper dying before either was written.

    const r = reconcileRun(RUN.id, GONE);
    assert.deepEqual(r.taskChanges, [{ taskId, from: "running", to: "failed", reason: "container_gone_worktree_dirty" }]);

    const t = getTask(taskId)!;
    assert.equal(t.status, "failed");
    assert.match(t.error ?? "", /orphaned_work_may_persist/);
    // Runnable command — task id included, not a bare `forge retry --force`.
    assert.match(t.error ?? "", new RegExp(`forge retry ${taskId} --force`));

    const failed = eventsForTask(taskId).find((e) => e.eventType === "task.failed")!;
    const payload = failed.payload as Record<string, unknown>;
    assert.equal(payload.failure_kind, "orphaned_work_may_persist");
    const evidence = payload.evidence as OrphanEvidence;
    assert.equal(evidence.containerName, `forge-${taskId}`);
    assert.equal(evidence.containerLiveness, "gone");
    assert.equal(evidence.resultState, "absent");
    assert.equal(evidence.recoverableStdoutResult, false);
    assert.equal(evidence.worktreePathChecked, gitDir);
    assert.deepEqual(evidence.changedFiles, ["?? changed-file.txt"]);
    assert.equal(evidence.source, "worktree", "a dedicated worktree_path is task-exclusive, confident evidence");

    // The reconciled event carries the same evidence, for any consumer walking events only.
    const reconciled = eventsForTask(taskId).find((e) => e.eventType === "task.reconciled")!;
    assert.equal((reconciled.payload as Record<string, unknown>).reason, "container_gone_worktree_dirty");
    assert.deepEqual((reconciled.payload as Record<string, unknown>).evidence, evidence);
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
});

test("FG-455: worktree_path takes precedence over run.projectDir when both are set", () => {
  const gitDir = makeDirtyGitRepo();
  const otherDir = mkdtempSync(join(tmpdir(), "forge-rec-other-"));
  try {
    insertRun({ id: "run-rec-precedence", workflow: "invoke", title: "prec", status: "active", createdAt: "2026-05-30T00:00:00Z", projectDir: otherDir });
    const taskId = "t-precedence";
    insertContainerized(mkTask(taskId, { runId: "run-rec-precedence", status: "running", worktreePath: gitDir }));

    reconcileRun("run-rec-precedence", GONE);

    const failed = eventsForTask(taskId).find((e) => e.eventType === "task.failed")!;
    const evidence = (failed.payload as Record<string, unknown>).evidence as OrphanEvidence;
    assert.equal(evidence.worktreePathChecked, gitDir, "worktreePath (the actual persisted-work location) wins over run.projectDir");
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }
});

// ----- FG-479: container-gone-with-result must NEVER complete a PIPELINE task -----
// In a pipeline the task stays `running` through the post-container host-side
// sequence (worktree merge → integration gate → reds → finalizePrimary), so a
// valid result.json only proves the AGENT finished. Completing it from reconcile
// would silently skip reds, verdict/human gates, and the worktree merge-back.

const PIPELINE_RUN: Run = { id: "run-rec-pipeline", workflow: "feature", title: "pipeline rec", status: "active", createdAt: "2026-05-30T00:00:00Z" };

test("FG-479: PIPELINE run, container gone WITH a valid result → failed orphaned_needs_finalize, NOT complete; reds/gates not skipped; result preserved; run stays active", () => {
  insertRun(PIPELINE_RUN);
  const taskId = "t-pipe-result";
  insertContainerized(mkTask(taskId, { runId: PIPELINE_RUN.id, status: "running", phase: "build",
    taskPackage: { taskId, runId: PIPELINE_RUN.id, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" } }));
  const dir = taskDir(PIPELINE_RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  const result = { status: "complete", output: "agent finished but finalize never ran" };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));

  const r = reconcileRun(PIPELINE_RUN.id, GONE);
  assert.deepEqual(r.taskChanges, [{ taskId, from: "running", to: "failed", reason: "container_gone_pipeline_unfinalized" }]);

  const t = getTask(taskId)!;
  assert.equal(t.status, "failed", "a pipeline task must never be reconciled to complete — that skips reds, the integration gate, human gates, and merge-back");
  assert.match(t.error ?? "", /orphaned_needs_finalize/);
  // Runnable command — task id included, not a bare `forge retry --force`.
  assert.match(t.error ?? "", new RegExp(`forge retry ${taskId} --force`));
  assert.deepEqual(t.result, result, "the agent's result is preserved on the row as evidence, not discarded");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")), result, "result.json on disk is untouched");

  const types = eventsForTask(taskId).map((e) => e.eventType);
  assert.ok(!types.includes("task.completed"), "no task.completed — completion (and reds dispatch after it) belongs to the real runNext path");
  assert.ok(types.includes("task.failed") && types.includes("task.reconciled"));

  // Reds NOT skipped: reconcileRun must never itself spawn a red — the only way
  // a red gets dispatched is dispatchReds (runNext.ts), which inserts a new task
  // row with parentId === the primary's id. Assert none exists, rather than only
  // inferring "no reds ran" from the absence of task.completed above.
  assert.deepEqual(tasksForRun(PIPELINE_RUN.id).filter((t) => t.parentId === taskId), [], "reconcileRun must never spawn/skip reds for this primary");

  const failed = eventsForTask(taskId).find((e) => e.eventType === "task.failed")!;
  const payload = failed.payload as Record<string, unknown>;
  assert.equal(payload.failure_kind, "orphaned_needs_finalize");
  const evidence = payload.evidence as OrphanEvidence;
  assert.equal(evidence.containerLiveness, "gone");
  assert.equal(evidence.resultState, "valid");

  // Run-level: pipelines are finalized by forge next, never by reconcile.
  assert.equal(r.runChange, undefined);
  assert.equal(getRun(PIPELINE_RUN.id)!.status, "active");
});

test("FG-479: PIPELINE run, stdout-recoverable result (no result.json) → failed orphaned_needs_finalize, NOT complete; inferred result preserved", () => {
  insertRun(PIPELINE_RUN);
  const taskId = "t-pipe-stdout";
  insertContainerized(mkTask(taskId, { runId: PIPELINE_RUN.id, status: "running", agentRole: "research-specialist", phase: "build",
    taskPackage: { taskId, runId: PIPELINE_RUN.id, phase: "build", role: "research-specialist", inputs: {}, composedSystemPrompt: "" } }));
  const dir = taskDir(PIPELINE_RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writePiManifest(dir);
  const text = "Recovered narrative output from stdout.";
  writeFileSync(join(dir, "container.stdout.log"), piCleanEndStdout(text));
  // result.json intentionally absent.

  const r = reconcileRun(PIPELINE_RUN.id, GONE);
  assert.deepEqual(r.taskChanges, [{ taskId, from: "running", to: "failed", reason: "container_gone_pipeline_unfinalized" }]);

  const t = getTask(taskId)!;
  assert.equal(t.status, "failed", "a recovered stdout result proves the agent finished, not that the finalize ran");
  assert.deepEqual(t.result, { contract: "inferred", summary: text, status: "complete" }, "the inferred result is preserved on the row as evidence");

  const types = eventsForTask(taskId).map((e) => e.eventType);
  assert.ok(!types.includes("task.completed"), "must NOT be completed");

  // Reds NOT skipped: see the sibling test above for why this checks task rows
  // directly rather than only inferring it from the absence of task.completed.
  assert.deepEqual(tasksForRun(PIPELINE_RUN.id).filter((t) => t.parentId === taskId), [], "reconcileRun must never spawn/skip reds for this primary");

  const failed = eventsForTask(taskId).find((e) => e.eventType === "task.failed")!;
  const payload = failed.payload as Record<string, unknown>;
  assert.equal(payload.failure_kind, "orphaned_needs_finalize");
  assert.equal((payload.evidence as OrphanEvidence).recoverableStdoutResult, true);

  // The inferred result is persisted to disk too (evidence for forge show/recover).
  const onDisk = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as Record<string, unknown>;
  assert.equal(onDisk.summary, text);
});

// ----- FG-486: invoke_chain runs are NOT pipeline runs at the TASK level -----
// Campaign quick lanes create workflow "invoke_chain" runs whose tasks are
// plain invokes (no merge/gate/reds). Container-gone-with-result must complete
// them like invoke tasks — the FG-479 guard wrongly landed them
// orphaned_needs_finalize. Run-level completion stays invoke-only: whether the
// chain has another invoke coming is known only to the campaign executor.

const INVOKE_CHAIN_RUN: Run = { id: "run-rec-chain", workflow: "invoke_chain", title: "chain rec", status: "active", createdAt: "2026-05-30T00:00:00Z" };

test("FG-486: invoke_chain run, container gone WITH a valid result → task COMPLETED (not orphaned_needs_finalize)", () => {
  insertRun(INVOKE_CHAIN_RUN);
  const taskId = "t-chain-result";
  insertContainerized(mkTask(taskId, { runId: INVOKE_CHAIN_RUN.id }));
  const dir = taskDir(INVOKE_CHAIN_RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", output: "quick lane done" }));

  const r = reconcileRun(INVOKE_CHAIN_RUN.id, GONE);
  assert.deepEqual(r.taskChanges, [{ taskId, from: "running", to: "complete", reason: "container_gone_result_present" }]);
  assert.equal(getTask(taskId)!.status, "complete", "no finalize exists to bypass — must complete like an invoke task");
  const types = eventsForTask(taskId).map((e) => e.eventType);
  assert.ok(types.includes("task.completed") && !types.includes("task.failed"));

  // Run-level completion stays invoke-only: the chain may have another invoke
  // coming that only the campaign executor knows about.
  assert.equal(r.runChange, undefined, "reconcile must never complete an invoke_chain RUN");
  assert.equal(getRun(INVOKE_CHAIN_RUN.id)!.status, "active");
});

test("FG-486: invoke_chain run, stdout-recoverable result → task COMPLETED from the inferred result", () => {
  insertRun(INVOKE_CHAIN_RUN);
  const taskId = "t-chain-stdout";
  insertContainerized(mkTask(taskId, { runId: INVOKE_CHAIN_RUN.id, agentRole: "research-specialist" }));
  const dir = taskDir(INVOKE_CHAIN_RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writePiManifest(dir);
  const text = "Recovered quick-lane output.";
  writeFileSync(join(dir, "container.stdout.log"), piCleanEndStdout(text));

  const r = reconcileRun(INVOKE_CHAIN_RUN.id, GONE);
  assert.deepEqual(r.taskChanges, [{ taskId, from: "running", to: "complete", reason: "container_gone_result_recovered_from_stdout" }]);
  assert.deepEqual(getTask(taskId)!.result, { contract: "inferred", summary: text, status: "complete" });
});

// ----- FG-455 red-review finding 2: honest evidence source on the projectDir fallback -----

test("FG-455 finding2: no worktree_path, dirty run.projectDir → orphaned_work_may_persist, but evidence/message disclose SHARED-projectDir ambiguity (not task-exclusive)", () => {
  const gitDir = makeDirtyGitRepo(); // stands in for the operator's shared project checkout
  try {
    insertRun({ id: "run-rec-shared", workflow: "invoke", title: "shared", status: "active", createdAt: "2026-05-30T00:00:00Z", projectDir: gitDir });
    const taskId = "t-no-worktree-shared";
    insertContainerized(mkTask(taskId, { runId: "run-rec-shared", status: "running" })); // no worktreePath

    const r = reconcileRun("run-rec-shared", GONE);
    assert.deepEqual(r.taskChanges, [{ taskId, from: "running", to: "failed", reason: "container_gone_worktree_dirty" }]);

    const t = getTask(taskId)!;
    assert.equal(t.status, "failed");
    assert.match(t.error ?? "", /orphaned_work_may_persist/);
    assert.match(t.error ?? "", /SHARED project directory/i, "the stored error must disclose the shared-projectDir ambiguity");

    const failed = eventsForTask(taskId).find((e) => e.eventType === "task.failed")!;
    const evidence = (failed.payload as Record<string, unknown>).evidence as OrphanEvidence;
    assert.equal(evidence.worktreePathChecked, gitDir);
    assert.equal(evidence.source, "project_dir_shared", "no dedicated worktree → the fallback source must be recorded, not claimed task-exclusive");

    const message = orphanRecoveryMessage("run-rec-shared", taskId, evidence);
    assert.match(message, /SHARED project directory/i);
    assert.match(message, /unrelated uncommitted changes/i);
    assert.match(message, /evidence to inspect, not proof of task work/i);
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
});

test("FG-455 NEGATIVE: non-empty stdout with no recoverable result AND no changed files → ordinary orphaned (stdout alone is not proof of persisted work)", () => {
  const taskId = "t-stdout-not-proof";
  insertContainerized(mkTask(taskId, { status: "running" })); // agentRole: "engineer" — requires structured result
  const dir = taskDir(RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writePiManifest(dir);
  // agent_start only — no agent_end, so analyzePiFailure finds no finalAssistantText.
  // Non-empty, but nothing recoverable and no worktree configured (no changed files).
  writeFileSync(join(dir, "container.stdout.log"), JSON.stringify({ type: "agent_start" }) + "\n");

  const r = reconcileRun(RUN.id, GONE);
  assert.deepEqual(r.taskChanges, [{ taskId, from: "running", to: "failed", reason: "container_gone_no_result" }]);

  const t = getTask(taskId)!;
  assert.equal(t.status, "failed");
  assert.doesNotMatch(t.error ?? "", /orphaned_work_may_persist/);

  const failed = eventsForTask(taskId).find((e) => e.eventType === "task.failed")!;
  assert.equal((failed.payload as Record<string, unknown>).failure_kind, "orphaned", "ordinary orphaned — unchanged classification/shape");
  assert.equal((failed.payload as Record<string, unknown>).evidence, undefined, "ordinary orphaned carries no evidence payload (happy path unchanged)");

  // FG-455 review finding 2: the ordinary-orphaned outcome must still carry the
  // evidence tuple on its task.reconciled event, same as the other two outcomes.
  const reconciled = eventsForTask(taskId).find((e) => e.eventType === "task.reconciled")!;
  const evidence = (reconciled.payload as Record<string, unknown>).evidence as OrphanEvidence;
  assert.equal(evidence.containerName, `forge-${taskId}`);
  assert.equal(evidence.containerLiveness, "gone");
  assert.equal(evidence.recoverableStdoutResult, false);
  assert.deepEqual(evidence.changedFiles, []);
});

// ----- FG-455 red-review finding 1: never-throw on unreadable result.json -----

test("FG-455 finding1: result.json path is a directory (TOCTOU/unreadable-file stand-in) → reconcileRun completes without throwing, classifies orphaned", () => {
  const taskId = "t-result-is-dir";
  insertContainerized(mkTask(taskId, { status: "running" }));
  const dir = taskDir(RUN.id, taskId);
  // A directory where result.json is expected: readFileSync throws EISDIR,
  // simulating "the file vanished / became unreadable between existsSync and
  // readFileSync" without needing an actual race.
  mkdirSync(join(dir, "result.json"), { recursive: true });

  let r: ReturnType<typeof reconcileRun> | undefined;
  assert.doesNotThrow(() => { r = reconcileRun(RUN.id, GONE); });
  assert.deepEqual(r!.taskChanges, [{ taskId, from: "running", to: "failed", reason: "container_gone_no_result" }]);

  const t = getTask(taskId)!;
  assert.equal(t.status, "failed", "gracefully classified, not crashed");
  const failed = eventsForTask(taskId).find((e) => e.eventType === "task.failed")!;
  assert.equal((failed.payload as Record<string, unknown>).failure_kind, "orphaned");
});

test("reconcile: a host-side session task (no container.started) is NEVER reconciled (regression)", () => {
  // forge design / orchestrator session tasks run host-side, not in a container.
  // docker inspect would say "gone" — but they must NOT be orphaned. The guard is
  // the absence of a container.started event. (Caught live on the real DB.)
  insertTask(mkTask("task-session-x", { status: "running", phase: "session", agentRole: "orchestrator" }));
  const r = reconcileRun(RUN.id, GONE); // GONE = docker says no such container
  assert.equal(r.taskChanges.length, 0, "no container.started → not reconcilable");
  assert.equal(getTask("task-session-x")!.status, "running", "session task stays running");
});

test("reconcile: active invoke run with no live work → run completed + run.reconciled event", () => {
  insertTask(mkTask("t-done", { status: "complete" }));
  const r = reconcileRun(RUN.id, ALIVE);
  assert.ok(r.runChange, "run should be reconciled");
  assert.equal(r.runChange!.to, "complete");
  assert.equal(getRun(RUN.id)!.status, "complete");
  assert.ok(eventsForRun(RUN.id).some((e) => e.eventType === "run.reconciled"));
});

test("reconcile: orphaned last task ALSO completes the invoke run (chained)", () => {
  insertContainerized(mkTask("t-only", { status: "running" }));
  const r = reconcileRun(RUN.id, GONE);
  assert.equal(getTask("t-only")!.status, "failed");
  assert.equal(getRun(RUN.id)!.status, "complete", "run with all-terminal tasks completes");
  assert.ok(r.runChange);
});

test("reconcile: does NOT complete a multi-step pipeline run (only invoke runs)", () => {
  insertRun({ id: "run-pipe", workflow: "feature", title: "pipe", status: "active", createdAt: "2026-05-30T00:00:00Z" });
  insertTask(mkTask("p1", { runId: "run-pipe", status: "complete" }));
  const r = reconcileRun("run-pipe", ALIVE);
  assert.equal(r.runChange, undefined, "pipeline run-completion is left to forge next (has the workflow)");
  assert.equal(getRun("run-pipe")!.status, "active");
});

test("reconcileRuns: only reconciles the given run ids — other workspaces' runs are untouched (scoping)", () => {
  // run-rec (this workspace) has an orphaned containerized task.
  insertContainerized(mkTask("t-mine", { status: "running" }));
  // A run in ANOTHER workspace, also with an orphaned task — must NOT be touched.
  insertRun({ id: "run-other-ws", workflow: "invoke", title: "other", status: "active", createdAt: "2026-05-30T00:00:00Z", projectDir: "/other/ws" });
  insertContainerized(mkTask("t-theirs", { runId: "run-other-ws", status: "running" }));

  const changed = reconcileRuns([RUN.id], GONE); // scoped to this workspace's run only
  assert.deepEqual(changed.map((c) => c.runId), [RUN.id]);
  assert.equal(getTask("t-mine")!.status, "failed", "in-scope orphan reconciled");
  assert.equal(getTask("t-theirs")!.status, "running", "out-of-scope run left untouched");
  assert.equal(getRun("run-other-ws")!.status, "active", "out-of-scope run not completed");
});

test("reconcile: idempotent — a second pass changes nothing and emits no new events", () => {
  insertContainerized(mkTask("t-i", { status: "running" }));
  reconcileRun(RUN.id, GONE);
  const eventsAfterFirst = eventsForRun(RUN.id).length;
  const r2 = reconcileRun(RUN.id, GONE);
  assert.equal(r2.taskChanges.length, 0, "nothing to change on the second pass");
  assert.equal(r2.runChange, undefined);
  assert.equal(eventsForRun(RUN.id).length, eventsAfterFirst, "no duplicate events");
});

test("reconcile: terminalizing an orphaned task ALSO removes its staged auth-state (AWN-8 finding)", async () => {
  const { writeFileSync, existsSync, mkdirSync } = await import("node:fs");
  insertContainerized(mkTask("task-auth", { status: "running" }));
  const dir = taskDir(RUN.id, "task-auth");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth-state.json"), JSON.stringify({ bearer: "leak" }));

  reconcileRun(RUN.id, GONE); // container gone, no result → orphaned/failed
  assert.equal(getTask("task-auth")!.status, "failed");
  assert.equal(existsSync(join(dir, "auth-state.json")), false, "staged auth must be cleaned up on reconcile-terminalize");
});

// ----- finalizeOrphanedPrimaries (duplicate-primary self-heal) -----

test("reconcile: orphaned pending primary in a phase already completed → failed/orphaned + reconciled event", () => {
  // The forge-site shape: a real build primary completed; a later `forge retry`
  // primary is stranded pending. (Primaries here are NOT containerized — they're
  // the parent fanout rows; insertTask directly, no container.started.)
  insertTask(mkTask("build-real", { phase: "build", status: "complete" }));
  insertTask(mkTask("build-orphan", { phase: "build", status: "pending", createdAt: "2026-05-30T01:00:00Z" }));

  const r = reconcileRun(RUN.id, ALIVE);
  assert.deepEqual(
    r.taskChanges,
    [{ taskId: "build-orphan", from: "pending", to: "failed", reason: "orphaned_duplicate_primary" }],
  );
  assert.equal(getTask("build-orphan")!.status, "failed");
  assert.equal(getTask("build-real")!.status, "complete", "the real primary is untouched");
  const types = eventsForTask("build-orphan").map((e) => e.eventType);
  assert.ok(types.includes("task.failed") && types.includes("task.reconciled"));
  const failed = eventsForTask("build-orphan").find((e) => e.eventType === "task.failed")!;
  assert.equal((failed.payload as Record<string, unknown>).failure_kind, "orphaned");
});

test("reconcile: a pending primary with NO completed sibling primary is left alone (legit pending work)", () => {
  insertTask(mkTask("build-1", { phase: "build", status: "failed" }));
  insertTask(mkTask("build-2", { phase: "build", status: "pending", createdAt: "2026-05-30T01:00:00Z" }));
  const r = reconcileRun(RUN.id, ALIVE);
  assert.equal(r.taskChanges.length, 0, "no complete primary ⇒ this is a normal retry, not an orphan");
  assert.equal(getTask("build-2")!.status, "pending");
});

test("reconcile: orphan-primary finalize is idempotent", () => {
  insertTask(mkTask("build-real", { phase: "build", status: "complete" }));
  insertTask(mkTask("build-orphan", { phase: "build", status: "pending", createdAt: "2026-05-30T01:00:00Z" }));
  reconcileRun(RUN.id, ALIVE);
  const second = reconcileRun(RUN.id, ALIVE);
  assert.equal(second.taskChanges.length, 0, "second pass finds the orphan already failed");
});

test("reconcile: a completed-phase child (red) task is never treated as an orphan primary", () => {
  insertTask(mkTask("build-real", { phase: "build", status: "complete" }));
  insertTask(mkTask("build-red", { phase: "build", status: "pending", parentId: "build-real", createdAt: "2026-05-30T01:00:00Z" }));
  const r = reconcileRun(RUN.id, ALIVE);
  assert.equal(r.taskChanges.length, 0, "children are not primaries — left alone");
  assert.equal(getTask("build-red")!.status, "pending");
});

// ----- FG-455 p2: fanout PARENT stuck `running` after its children settle -----

// FG-479 review finding 4: all children finishing only proves the WAVE
// finished — the parent's own host-side finalize (integration merge →
// integration gate → reds, runNext.ts dispatchFanoutStep) never ran, so
// reconcile must not complete the parent from child aggregation alone. Same
// bypass class as the PIPELINE single-step fix above, just on the fanout
// parent lifecycle — land fail-safe (re-drivable), never complete.
test("FG-479 review finding 4: fanout parent stuck running, all children complete → parent still lands FAILED (finalize never ran), not complete", () => {
  insertTask(mkTask("fanout-parent-a", { status: "running" }));
  insertTask(mkTask("fanout-child-a1", { parentId: "fanout-parent-a", status: "complete" }));
  insertTask(mkTask("fanout-child-a2", { parentId: "fanout-parent-a", status: "complete" }));

  const r = reconcileRun(RUN.id, ALIVE);

  assert.deepEqual(
    r.taskChanges.find((c) => c.taskId === "fanout-parent-a"),
    { taskId: "fanout-parent-a", from: "running", to: "failed", reason: "fanout_wave_unfinalized" },
  );
  const parent = getTask("fanout-parent-a")!;
  assert.equal(parent.status, "failed", "must never complete purely from child aggregation — the parent's own merge/integration-gate/reds never ran");
  assert.match(parent.error ?? "", /forge recover fanout-parent-a --re-drive/);
  const types = eventsForTask("fanout-parent-a").map((e) => e.eventType);
  assert.ok(!types.includes("task.completed"), "no task.completed — completing here would skip the parent's own finalize sequence");
  assert.ok(types.includes("task.failed") && types.includes("task.reconciled"));

  const failed = eventsForTask("fanout-parent-a").find((e) => e.eventType === "task.failed")!;
  const payload = failed.payload as Record<string, unknown>;
  assert.equal(payload.failure_kind, "fanout_wave_orphaned", "reuses the existing recoverable kind — same recover --re-drive path already re-drives the whole wave");
  assert.deepEqual(payload.childSummary, { total: 2, complete: 2 });

  // The existing re-drive mechanism must still be able to recover it.
  const outcome = performReDrive("fanout-parent-a");
  assert.equal(outcome.kind, "re-drive-done");
});

test("FG-455 p2: fanout parent stuck running, one child orphaned (container gone) → parent reconciled to failed, pointing at recovery", () => {
  insertTask(mkTask("fanout-parent-b", { status: "running" }));
  insertTask(mkTask("fanout-child-b1", { parentId: "fanout-parent-b", status: "complete" }));
  insertContainerized(mkTask("fanout-child-b2", { parentId: "fanout-parent-b", status: "running" }));

  const r = reconcileRun(RUN.id, GONE);

  // The orphaned child is resolved by the per-task loop first.
  assert.equal(getTask("fanout-child-b2")!.status, "failed");

  const parentChange = r.taskChanges.find((c) => c.taskId === "fanout-parent-b");
  assert.deepEqual(parentChange, { taskId: "fanout-parent-b", from: "running", to: "failed", reason: "fanout_wave_orphaned" });
  assert.equal(getTask("fanout-parent-b")!.status, "failed", "parent must leave running");

  const failedEvent = eventsForTask("fanout-parent-b").find((e) => e.eventType === "task.failed")!;
  const payload = failedEvent.payload as Record<string, unknown>;
  assert.equal(payload.failure_kind, "fanout_wave_orphaned");
  assert.match(payload.error as string, /forge recover fanout-parent-b --re-drive/);
  assert.match(payload.error as string, /forge show fanout-parent-b/);
});

test("FG-455 p2: fanout parent stuck running, a child still has a LIVE container → parent NOT reconciled (stays running)", () => {
  insertTask(mkTask("fanout-parent-c", { status: "running" }));
  insertTask(mkTask("fanout-child-c1", { parentId: "fanout-parent-c", status: "complete" }));
  insertContainerized(mkTask("fanout-child-c2", { parentId: "fanout-parent-c", status: "running" }));

  const r = reconcileRun(RUN.id, ALIVE); // fanout-child-c2's container is still alive

  assert.equal(r.taskChanges.filter((c) => c.taskId === "fanout-parent-c").length, 0);
  assert.equal(getTask("fanout-parent-c")!.status, "running", "parent left alone — wave may still be in progress");
  assert.equal(getTask("fanout-child-c2")!.status, "running", "live child untouched too");
});

test("FG-455 p2: a running task with NO children at all is never treated as a fanout parent (regression)", () => {
  insertTask(mkTask("plain-running", { status: "running" }));
  const r = reconcileRun(RUN.id, ALIVE);
  assert.equal(r.taskChanges.filter((c) => c.taskId === "plain-running").length, 0);
  assert.equal(getTask("plain-running")!.status, "running");
});

// ----- FG-437: reconciler recovers a task crashed mid dependency-provisioning -----

const PROVISION_PAYLOAD = { containerName: "forge-provision-abc123", cacheKey: "abc123", phase: "dependency_provisioning" };

// Insert a task that crashed after task.started but before container.started —
// while its (separately-named, forge-provision-<cacheKey>) dependency
// provisioner was running. No container.started event exists for this task.
function insertProvisioning(t: Task) {
  insertTask(t);
  logEvent("container.provision_started", { runId: t.runId, taskId: t.id, payload: PROVISION_PAYLOAD });
}

test("FG-437: crashed mid-provision, provisioner gone → task recovered to failed + provisioner reaped", () => {
  insertProvisioning(mkTask("t-provision-crash", { status: "running" }));
  const reaped: string[] = [];
  const reap = (name: string) => { reaped.push(name); return "killed" as const; };
  const containerAliveFn = (name: string) => {
    assert.equal(name, "forge-provision-abc123", "liveness is checked against the REAL provisioner container name, not forge-<taskId>");
    return false; // confirmed gone
  };

  const r = reconcileRun(RUN.id, containerAliveFn, reap);

  assert.deepEqual(r.taskChanges, [{ taskId: "t-provision-crash", from: "running", to: "failed", reason: "provisioning_phase_crash" }]);
  assert.equal(getTask("t-provision-crash")!.status, "failed");
  assert.deepEqual(reaped, ["forge-provision-abc123"], "the orphaned provisioner container was reaped");

  const failed = eventsForTask("t-provision-crash").find((e) => e.eventType === "task.failed")!;
  const failedPayload = failed.payload as Record<string, unknown>;
  assert.equal(failedPayload.failure_kind, "verification_environment_unavailable");
  assert.match(failedPayload.error as string, /forge retry t-provision-crash/, "reason points at recovery");

  const reconciled = eventsForTask("t-provision-crash").find((e) => e.eventType === "task.reconciled")!;
  const reconciledPayload = reconciled.payload as Record<string, unknown>;
  assert.equal(reconciledPayload.reason, "provisioning_phase_crash");
  const evidence = reconciledPayload.evidence as Record<string, unknown>;
  assert.equal(evidence.containerName, "forge-provision-abc123", "evidence carries the containerName");
  assert.equal(evidence.cacheKey, "abc123", "evidence carries the cacheKey");
  assert.equal(evidence.provisionerLiveness, "gone");
});

test("FG-437: provisioner still ALIVE → task left running, NOT reaped, NOT failed (FG-376 don't-kill-a-live-install rule)", () => {
  insertProvisioning(mkTask("t-provision-live", { status: "running" }));
  let reapCalled = false;
  const reap = (): "killed" => { reapCalled = true; return "killed"; };

  const r = reconcileRun(RUN.id, ALIVE, reap); // ALIVE: provisioner still alive

  assert.equal(r.taskChanges.filter((c) => c.taskId === "t-provision-live").length, 0);
  assert.equal(getTask("t-provision-live")!.status, "running", "install may still be in flight — never touched");
  assert.equal(reapCalled, false, "a live provisioner container is never reaped");
});

test("FG-437: not a false positive — a running task WITH container.started reaches the existing agent-container logic unaffected", () => {
  // Provisioning succeeded and the agent container launched normally: BOTH
  // provision_started and container.started exist. The new branch must not
  // intercept this — it should fall through to the pre-existing container-gone
  // handling exactly as before FG-437.
  insertTask(mkTask("t-normal-agent", { status: "running" }));
  logEvent("container.provision_started", { runId: RUN.id, taskId: "t-normal-agent", payload: PROVISION_PAYLOAD });
  logEvent("container.started", { runId: RUN.id, taskId: "t-normal-agent", payload: { containerName: "forge-t-normal-agent" } });

  const r = reconcileRun(RUN.id, GONE);

  const change = r.taskChanges.find((c) => c.taskId === "t-normal-agent");
  assert.equal(change?.reason, "container_gone_no_result", "handled by the existing agent-container path, not the FG-437 provisioning branch");
});

test("FG-437: not a false positive — a running task with NEITHER provision_started nor container.started is still skipped as today", () => {
  insertTask(mkTask("t-session-y", { status: "running", phase: "session", agentRole: "orchestrator" }));
  const r = reconcileRun(RUN.id, GONE);
  assert.equal(r.taskChanges.length, 0, "no signal at all → left alone, exactly as before FG-437");
  assert.equal(getTask("t-session-y")!.status, "running");
});

test("FG-437 red-review fix1: provision_succeeded fired but container.started has NOT — healthy mid-dispatch task is NOT claimed by the provisioning-crash branch", () => {
  // Between provision_succeeded and container.started the provisioner has
  // already --rm-removed itself and the agent container simply hasn't started
  // yet — this is a HEALTHY task, not a crash, and must not be false-failed.
  insertProvisioning(mkTask("t-mid-dispatch", { status: "running" }));
  logEvent("container.provision_succeeded", { runId: RUN.id, taskId: "t-mid-dispatch", payload: PROVISION_PAYLOAD });

  const reap = (): never => { throw new Error("must not be called — task is healthy, not crashed"); };
  const r = reconcileRun(RUN.id, GONE, reap); // GONE: even if a naive check asked, the provisioner container is gone (expected — it already exited)

  assert.equal(r.taskChanges.filter((c) => c.taskId === "t-mid-dispatch").length, 0, "not claimed by the provisioning-crash branch");
  assert.equal(getTask("t-mid-dispatch")!.status, "running", "left running — mid-dispatch, not a crash");
});

test("FG-437 fix2: reap failure ('error') never blocks the task transition — task still fails, reconcileRun does not throw, evidence.reapResult='error'", () => {
  insertProvisioning(mkTask("t-provision-reap-error", { status: "running" }));
  const reap = (): "error" => "error";

  let r: ReturnType<typeof reconcileRun> | undefined;
  assert.doesNotThrow(() => { r = reconcileRun(RUN.id, GONE, reap); });

  assert.deepEqual(r!.taskChanges, [{ taskId: "t-provision-reap-error", from: "running", to: "failed", reason: "provisioning_phase_crash" }]);
  assert.equal(getTask("t-provision-reap-error")!.status, "failed", "a reap failure never blocks the task transition");

  const failed = eventsForTask("t-provision-reap-error").find((e) => e.eventType === "task.failed")!;
  const evidence = (failed.payload as Record<string, unknown>).evidence as Record<string, unknown>;
  assert.equal(evidence.reapResult, "error");

  const reconciled = eventsForTask("t-provision-reap-error").find((e) => e.eventType === "task.reconciled")!;
  const reconciledEvidence = (reconciled.payload as Record<string, unknown>).evidence as Record<string, unknown>;
  assert.equal(reconciledEvidence.reapResult, "error");
});

test("FG-437 fix2: reap THROWS — is caught, treated as 'error', task still fails, reconcileRun does not throw", () => {
  insertProvisioning(mkTask("t-provision-reap-throws", { status: "running" }));
  const reap = (): never => { throw new Error("docker daemon unreachable"); };

  let r: ReturnType<typeof reconcileRun> | undefined;
  assert.doesNotThrow(() => { r = reconcileRun(RUN.id, GONE, reap); });

  assert.deepEqual(r!.taskChanges, [{ taskId: "t-provision-reap-throws", from: "running", to: "failed", reason: "provisioning_phase_crash" }]);
  assert.equal(getTask("t-provision-reap-throws")!.status, "failed");

  const failed = eventsForTask("t-provision-reap-throws").find((e) => e.eventType === "task.failed")!;
  const evidence = (failed.payload as Record<string, unknown>).evidence as Record<string, unknown>;
  assert.equal(evidence.reapResult, "error", "a thrown reap is caught and recorded as 'error', not propagated");
});

test("FG-437 fix2: gone→recovered — evidence.reapResult matches the injected reaper's return value, and the reaper is called with the exact forge-provision-<cacheKey> name", () => {
  const calledWith: string[] = [];
  const reap = (name: string): "not_found" => { calledWith.push(name); return "not_found"; };
  insertProvisioning(mkTask("t-provision-not-found", { status: "running" }));

  const r = reconcileRun(RUN.id, GONE, reap);

  assert.deepEqual(r.taskChanges, [{ taskId: "t-provision-not-found", from: "running", to: "failed", reason: "provisioning_phase_crash" }]);
  assert.deepEqual(calledWith, ["forge-provision-abc123"], "reaper called with the exact provisioner name from the provision_started payload");

  const reconciled = eventsForTask("t-provision-not-found").find((e) => e.eventType === "task.reconciled")!;
  const evidence = (reconciled.payload as Record<string, unknown>).evidence as Record<string, unknown>;
  assert.equal(evidence.reapResult, "not_found", "evidence records exactly what the injected reaper returned");
});

test("reconcileRuns: forwards an injected reapContainer through to reconcileRun for the FG-437 provisioning-crash branch", () => {
  insertProvisioning(mkTask("t-plural-reap", { status: "running" }));
  const calledWith: string[] = [];
  const reap = (name: string): "killed" => { calledWith.push(name); return "killed"; };

  const changed = reconcileRuns([RUN.id], GONE, reap);

  assert.deepEqual(calledWith, ["forge-provision-abc123"], "reconcileRuns forwarded the injected reaper into reconcileRun");
  assert.equal(getTask("t-plural-reap")!.status, "failed");
  assert.ok(changed.some((c) => c.runId === RUN.id));
});

// ----- FG-455 p4: OOM / SIGKILL / exit-137 classification -----

const UNKNOWN_EXIT_INFO = () => ({});

test("FG-455 p4: container gone, no recoverable result, dirty worktree, containerExitInfo says oomKilled → failure_kind=oom_killed (not orphaned_work_may_persist)", () => {
  const gitDir = makeDirtyGitRepo();
  try {
    const taskId = "t-oom-killed";
    insertContainerized(mkTask(taskId, { status: "running", worktreePath: gitDir }));
    const exitInfo = (name: string) => {
      assert.equal(name, `forge-${taskId}`, "exit-info probe called with the agent container's real name");
      return { oomKilled: true, exitCode: 137 };
    };

    const r = reconcileRun(RUN.id, GONE, undefined, exitInfo);

    assert.deepEqual(r.taskChanges, [{ taskId, from: "running", to: "failed", reason: "container_oom_killed" }]);
    const t = getTask(taskId)!;
    assert.equal(t.status, "failed");
    assert.match(t.error ?? "", /oom_killed/);
    assert.match(t.error ?? "", /work may have persisted/, "dirty worktree still surfaces the recovery guidance");

    const failed = eventsForTask(taskId).find((e) => e.eventType === "task.failed")!;
    const payload = failed.payload as Record<string, unknown>;
    assert.equal(payload.failure_kind, "oom_killed", "NOT classified as an ordinary implementation failure");
    const evidence = payload.evidence as OrphanEvidence;
    assert.equal(evidence.oomKilled, true);
    assert.equal(evidence.exitCode, 137);
    assert.deepEqual(evidence.changedFiles, ["?? changed-file.txt"]);

    const reconciled = eventsForTask(taskId).find((e) => e.eventType === "task.reconciled")!;
    assert.equal((reconciled.payload as Record<string, unknown>).reason, "container_oom_killed");
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
});

test("FG-455 p4: container gone, no recoverable result, CLEAN worktree, containerExitInfo says exitCode=137 (no oomKilled flag) → still oom_killed", () => {
  const taskId = "t-exit-137";
  insertContainerized(mkTask(taskId, { status: "running" })); // no worktreePath, no run.projectDir → no changed files
  const exitInfo = () => ({ exitCode: 137 });

  const r = reconcileRun(RUN.id, GONE, undefined, exitInfo);

  assert.deepEqual(r.taskChanges, [{ taskId, from: "running", to: "failed", reason: "container_oom_killed" }]);
  const t = getTask(taskId)!;
  assert.equal(t.status, "failed");
  assert.match(t.error ?? "", /oom_killed/);
  assert.doesNotMatch(t.error ?? "", /work may have persisted/, "no changed files — no false recovery guidance");

  const failed = eventsForTask(taskId).find((e) => e.eventType === "task.failed")!;
  const payload = failed.payload as Record<string, unknown>;
  assert.equal(payload.failure_kind, "oom_killed");
  const evidence = payload.evidence as OrphanEvidence;
  assert.equal(evidence.exitCode, 137);
  assert.equal(evidence.oomKilled, undefined);
});

test("FG-481: pipeline-run task, dirty worktree, oomKilled → persisted error never says 'continue from it' (recover --continue refuses pipeline tasks unconditionally)", () => {
  const gitDir = makeDirtyGitRepo();
  try {
    insertRun(PIPELINE_RUN);
    const taskId = "t-oom-pipeline";
    insertContainerized(mkTask(taskId, { runId: PIPELINE_RUN.id, status: "running", worktreePath: gitDir }));
    const exitInfo = () => ({ oomKilled: true, exitCode: 137 });

    reconcileRun(PIPELINE_RUN.id, GONE, undefined, exitInfo);

    const t = getTask(taskId)!;
    assert.match(t.error ?? "", /oom_killed/);
    assert.match(t.error ?? "", /work may have persisted/);
    assert.doesNotMatch(t.error ?? "", /continue from it/, "pipeline-run guidance must not recommend --continue — recover.ts refuses it unconditionally");
    assert.match(t.error ?? "", /forge retry .* --force/);
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
});

test("FG-481: pipeline-run task, dirty worktree, no oom evidence → orphaned_work_may_persist error never says 'continue from it'", () => {
  const gitDir = makeDirtyGitRepo();
  try {
    insertRun(PIPELINE_RUN);
    const taskId = "t-orphaned-pipeline";
    insertContainerized(mkTask(taskId, { runId: PIPELINE_RUN.id, status: "running", worktreePath: gitDir }));

    reconcileRun(PIPELINE_RUN.id, GONE, undefined, UNKNOWN_EXIT_INFO);

    const t = getTask(taskId)!;
    assert.match(t.error ?? "", /orphaned_work_may_persist/);
    assert.match(t.error ?? "", /work may have persisted/);
    assert.doesNotMatch(t.error ?? "", /continue from it/, "pipeline-run guidance must not recommend --continue — recover.ts refuses it unconditionally");
    assert.match(t.error ?? "", /forge retry .* --force/);
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
});

test("FG-455 p4 NEGATIVE: containerExitInfo returns {} (unknown) → classification UNCHANGED — still orphaned_work_may_persist on a dirty worktree", () => {
  const gitDir = makeDirtyGitRepo();
  try {
    const taskId = "t-oom-unknown-dirty";
    insertContainerized(mkTask(taskId, { status: "running", worktreePath: gitDir }));

    const r = reconcileRun(RUN.id, GONE, undefined, UNKNOWN_EXIT_INFO);

    assert.deepEqual(r.taskChanges, [{ taskId, from: "running", to: "failed", reason: "container_gone_worktree_dirty" }]);
    const failed = eventsForTask(taskId).find((e) => e.eventType === "task.failed")!;
    const payload = failed.payload as Record<string, unknown>;
    assert.equal(payload.failure_kind, "orphaned_work_may_persist", "unchanged from pre-FG-455-p4 behavior");
    const evidence = payload.evidence as OrphanEvidence;
    assert.equal(evidence.oomKilled, undefined);
    assert.equal(evidence.exitCode, undefined);
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
});

test("FG-455 p4 NEGATIVE: containerExitInfo returns {} (unknown), clean worktree → classification UNCHANGED — still ordinary orphaned", () => {
  const taskId = "t-oom-unknown-clean";
  insertContainerized(mkTask(taskId, { status: "running" }));

  const r = reconcileRun(RUN.id, GONE, undefined, UNKNOWN_EXIT_INFO);

  assert.deepEqual(r.taskChanges, [{ taskId, from: "running", to: "failed", reason: "container_gone_no_result" }]);
  const failed = eventsForTask(taskId).find((e) => e.eventType === "task.failed")!;
  assert.equal((failed.payload as Record<string, unknown>).failure_kind, "orphaned", "unchanged from pre-FG-455-p4 behavior");
});

test("FG-455 p4: defaultContainerExitInfo param defaults to the real probe when omitted — reconcileRun still never throws", () => {
  insertContainerized(mkTask("t-default-exit-info", { status: "running" }));
  // No containerExitInfo injected — falls back to defaultContainerExitInfo, which
  // shells out to `docker inspect`. In this sandboxed test env docker may not be
  // present at all; the never-throw guarantee must hold either way.
  let r: ReturnType<typeof reconcileRun> | undefined;
  assert.doesNotThrow(() => { r = reconcileRun(RUN.id, GONE); });
  assert.equal(getTask("t-default-exit-info")!.status, "failed");
  assert.ok(r);
});

test("FG-455 p4 review finding 4: container gone, containerExitInfo says oomKilled, AND a recoverable stdout result (FG-337 synthesis) exists → task COMPLETES via inferred-stdout, NOT classified oom_killed (recoverable output outranks OOM classification); evidence still carries exitCode/oomKilled alongside recoverableStdoutResult", () => {
  const taskId = "t-oom-with-stdout";
  insertContainerized(mkTask(taskId, { status: "running", agentRole: "research-specialist" }));
  const dir = taskDir(RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writePiManifest(dir);
  const text = "Recovered narrative output despite OOM.";
  writeFileSync(join(dir, "container.stdout.log"), piCleanEndStdout(text));
  const exitInfo = () => ({ oomKilled: true, exitCode: 137 });

  const r = reconcileRun(RUN.id, GONE, undefined, exitInfo);

  assert.deepEqual(r.taskChanges, [{ taskId, from: "running", to: "complete", reason: "container_gone_result_recovered_from_stdout" }]);
  const t = getTask(taskId)!;
  assert.equal(t.status, "complete");
  assert.deepEqual(t.result, { contract: "inferred", summary: text, status: "complete" });

  const types = eventsForTask(taskId).map((e) => e.eventType);
  assert.ok(types.includes("task.completed"), "must complete via the stdout-synthesis branch");
  assert.ok(!types.includes("task.failed"), "recoverable stdout outranks OOM classification — must not fail as oom_killed");

  const reconciled = eventsForTask(taskId).find((e) => e.eventType === "task.reconciled")!;
  const evidence = (reconciled.payload as Record<string, unknown>).evidence as OrphanEvidence;
  assert.equal(evidence.recoverableStdoutResult, true);
  assert.equal(evidence.oomKilled, true, "OOM evidence is still recorded even though it didn't drive classification");
  assert.equal(evidence.exitCode, 137);
});

test("FG-455 p4 review finding 5 NEGATIVE: containerExitInfo returns {exitCode:1, oomKilled:false} on a dirty-worktree no-result task → classified orphaned_work_may_persist, NOT oom_killed (only 137/oomKilled trips oom_killed)", () => {
  const gitDir = makeDirtyGitRepo();
  try {
    const taskId = "t-exit-1-dirty";
    insertContainerized(mkTask(taskId, { status: "running", worktreePath: gitDir }));
    const exitInfo = () => ({ exitCode: 1, oomKilled: false });

    const r = reconcileRun(RUN.id, GONE, undefined, exitInfo);

    assert.deepEqual(r.taskChanges, [{ taskId, from: "running", to: "failed", reason: "container_gone_worktree_dirty" }]);
    const failed = eventsForTask(taskId).find((e) => e.eventType === "task.failed")!;
    const payload = failed.payload as Record<string, unknown>;
    assert.equal(payload.failure_kind, "orphaned_work_may_persist", "a plain non-zero exit code does not trip oom_killed");
    const evidence = payload.evidence as OrphanEvidence;
    assert.equal(evidence.exitCode, 1);
    assert.equal(evidence.oomKilled, false);
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
});

// ----- FG-455 p4 Mode A: `complete` task with an empty result gets backfilled -----

function makeCompleteEmptyResult(taskId: string, o: Partial<Task> = {}): void {
  insertTask(mkTask(taskId, { status: "complete", ...o }));
}

test("FG-455 p4 Mode A: complete task, empty DB result + empty result.json, then result.json is populated → backfilled, status stays complete", () => {
  const taskId = "t-modea-backfill";
  makeCompleteEmptyResult(taskId);
  const dir = taskDir(RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  // Simulates the detached container writing result.json after the DB row was
  // already (wrongly) marked complete with nothing recorded.
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", output: "late write" }));

  const r = reconcileRun(RUN.id, ALIVE);

  assert.deepEqual(r.taskChanges, [{ taskId, from: "complete", to: "complete", reason: "complete_empty_result_backfilled" }]);
  const t = getTask(taskId)!;
  assert.equal(t.status, "complete", "status is untouched — only the result is backfilled");
  assert.deepEqual(t.result, { status: "complete", output: "late write" });

  const reconciled = eventsForTask(taskId).find((e) => e.eventType === "task.reconciled")!;
  const payload = reconciled.payload as Record<string, unknown>;
  assert.equal(payload.reason, "complete_empty_result_backfilled");
  assert.equal(payload.from, "complete");
  assert.equal(payload.to, "complete");
  assert.ok(!eventsForTask(taskId).some((e) => e.eventType === "task.failed"), "never fails the task");
});

test("FG-455 p4 Mode A: complete task, empty result.json, but a recoverable stdout result (FG-337 synthesis) → backfilled from stdout", () => {
  const taskId = "t-modea-stdout";
  makeCompleteEmptyResult(taskId, { agentRole: "research-specialist" });
  const dir = taskDir(RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writePiManifest(dir);
  const text = "Recovered narrative output from a detached-invoke wrapper.";
  writeFileSync(join(dir, "container.stdout.log"), piCleanEndStdout(text));
  // result.json intentionally absent.

  const r = reconcileRun(RUN.id, ALIVE);

  assert.deepEqual(r.taskChanges, [{ taskId, from: "complete", to: "complete", reason: "complete_empty_result_backfilled" }]);
  const t = getTask(taskId)!;
  assert.equal(t.status, "complete");
  assert.deepEqual(t.result, { contract: "inferred", summary: text, status: "complete" });

  const onDisk = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as Record<string, unknown>;
  assert.equal(onDisk.summary, text, "recovered result is also best-effort written to disk");
});

test("FG-455 p4 Mode A idempotency: complete task that ALREADY has a valid result → left untouched, no event, no change", () => {
  const taskId = "t-modea-healthy";
  insertTask(mkTask(taskId, { status: "complete", result: { status: "complete", output: "already fine" } }));

  const r = reconcileRun(RUN.id, ALIVE);

  assert.equal(r.taskChanges.filter((c) => c.taskId === taskId).length, 0, "healthy complete task is a no-op");
  const t = getTask(taskId)!;
  assert.deepEqual(t.result, { status: "complete", output: "already fine" });
  assert.equal(
    eventsForTask(taskId).some((e) => e.eventType === "task.reconciled"),
    false,
    "no reconciled event for a task that was never touched",
  );
});

test("FG-455 p4 Mode A no-recovery: complete task, empty DB result, empty result.json, no recoverable stdout → status stays complete, no crash, no spurious failure", () => {
  const taskId = "t-modea-no-recovery";
  makeCompleteEmptyResult(taskId);
  // No result.json, no manifest, no stdout log at all.

  let r: ReturnType<typeof reconcileRun> | undefined;
  assert.doesNotThrow(() => { r = reconcileRun(RUN.id, ALIVE); });

  assert.equal(r!.taskChanges.filter((c) => c.taskId === taskId).length, 0, "nothing recoverable — left alone");
  const t = getTask(taskId)!;
  assert.equal(t.status, "complete", "status is never flipped to failed for a complete task");
  assert.equal(t.result, undefined);
  assert.ok(!eventsForTask(taskId).some((e) => e.eventType === "task.failed"), "no spurious failure");
});

// FG-459: reconcileRun documents a never-throw invariant. The read/docker side
// already upholds it; these cover the DB-WRITE side — a SQLITE_BUSY-shaped throw
// (two forge processes reconciling the same run concurrently) must neither
// propagate out of reconcileRun nor abort reconciliation of the other tasks.

// A writer that throws SQLITE_BUSY-shaped on ONE chosen store method for ONE
// specific taskId, delegating every other call to the real store writers. Lets
// each test target exactly one of the three AC-named writes (markTaskComplete,
// markTaskFailed, backfillTaskResult) on exactly one task.
function busyOn(method: keyof ReconcileWriters, failingTaskId: string): ReconcileWriters {
  const busy = (): never => {
    const e = new Error("SQLITE_BUSY: database is locked") as Error & { code?: string };
    e.code = "SQLITE_BUSY";
    throw e;
  };
  return {
    markTaskComplete: (id, result) =>
      method === "markTaskComplete" && id === failingTaskId ? busy() : defaultReconcileWriters.markTaskComplete(id, result),
    markTaskFailed: (id, error, result) =>
      method === "markTaskFailed" && id === failingTaskId ? busy() : defaultReconcileWriters.markTaskFailed(id, error, result),
    backfillTaskResult: (id, result) =>
      method === "backfillTaskResult" && id === failingTaskId ? busy() : defaultReconcileWriters.backfillTaskResult(id, result),
  };
}

test("FG-459: a DB-write throw during one task's reconcile does not propagate out of reconcileRun", () => {
  insertContainerized(mkTask("t-busy", { status: "running" }));
  let r: ReturnType<typeof reconcileRun> | undefined;
  assert.doesNotThrow(() => {
    r = reconcileRun(RUN.id, GONE, defaultContainerReap, defaultContainerExitInfo, busyOn("markTaskFailed", "t-busy"));
  }, "a SQLITE_BUSY throw on the write must be swallowed, not propagated");
  // The failing task is left running (its write threw) — idempotent: a later
  // pass retries. Crucially it did NOT throw and did NOT get a bogus change.
  assert.equal(getTask("t-busy")!.status, "running");
  assert.equal(r!.taskChanges.filter((c) => c.taskId === "t-busy").length, 0);
});

test("FG-459: a DB-write throw on one task still reconciles the run's OTHER tasks", () => {
  insertContainerized(mkTask("t-busy", { status: "running" }));
  insertContainerized(mkTask("t-ok", { status: "running" }));
  let r: ReturnType<typeof reconcileRun> | undefined;
  assert.doesNotThrow(() => {
    r = reconcileRun(RUN.id, GONE, defaultContainerReap, defaultContainerExitInfo, busyOn("markTaskFailed", "t-busy"));
  });
  // t-busy's write threw → left running, no change recorded.
  assert.equal(getTask("t-busy")!.status, "running");
  // t-ok must still have been reconciled to failed despite the earlier throw.
  assert.equal(getTask("t-ok")!.status, "failed", "the throw must not abort reconcile of the remaining tasks");
  assert.equal(r!.taskChanges.filter((c) => c.taskId === "t-ok").length, 1);
  assert.ok(eventsForTask("t-ok").some((e) => e.eventType === "task.reconciled"));
});

test("FG-459: a DB-write throw on a task does not abort the run-level completion check", () => {
  // Two tasks: t-busy will throw on failed-write; t-done already has a valid
  // result and completes cleanly. With t-busy left running the run stays active
  // (correct — non-terminal work remains), proving the run-level pass RAN
  // (didn't get skipped by an escaping throw) and reached the right verdict.
  insertContainerized(mkTask("t-busy", { status: "running" }));
  insertContainerized(mkTask("t-done", { status: "running" }));
  const dir = taskDir(RUN.id, "t-done");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", output: "ok" }));

  let r: ReturnType<typeof reconcileRun> | undefined;
  assert.doesNotThrow(() => {
    r = reconcileRun(RUN.id, GONE, defaultContainerReap, defaultContainerExitInfo, busyOn("markTaskFailed", "t-busy"));
  });
  assert.equal(getTask("t-done")!.status, "complete");
  assert.equal(getTask("t-busy")!.status, "running");
  // Run has remaining non-terminal work (t-busy) → NOT completed. The absence of
  // a thrown error here is the point: the run-level block ran to a decision.
  assert.equal(r!.runChange, undefined);
});

// FG-459 (review round 1): the AC names all THREE writes (markTaskComplete,
// markTaskFailed, backfillTaskResult) and the fanout-parent pass explicitly.
// The tests above only exercise markTaskFailed in the per-task loop; these cover
// the other two writes and the fanout-parent pass directly.

test("FG-459: a markTaskComplete throw (container-gone valid-result branch) does not propagate, and other tasks still reconcile", () => {
  // t-cbusy has a valid result on disk → reconcile would markTaskComplete it.
  insertContainerized(mkTask("t-cbusy", { status: "running" }));
  const dir = taskDir(RUN.id, "t-cbusy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", output: "done" }));
  // t-ok is an ordinary orphan reconciled via the real markTaskFailed.
  insertContainerized(mkTask("t-ok", { status: "running" }));

  let r: ReturnType<typeof reconcileRun> | undefined;
  assert.doesNotThrow(() => {
    r = reconcileRun(RUN.id, GONE, defaultContainerReap, defaultContainerExitInfo, busyOn("markTaskComplete", "t-cbusy"));
  });
  assert.equal(getTask("t-cbusy")!.status, "running", "the completing write threw → left running (idempotent retry later)");
  assert.equal(r!.taskChanges.filter((c) => c.taskId === "t-cbusy").length, 0);
  assert.equal(getTask("t-ok")!.status, "failed", "a throw completing one task must not abort reconcile of the others");
});

test("FG-459: a backfillTaskResult throw (complete-empty backfill pass) does not propagate", () => {
  // A complete task with an empty DB result but a result.json on disk → the
  // backfill pass calls backfillTaskResult; force it to throw SQLITE_BUSY.
  const taskId = "t-bf-busy";
  makeCompleteEmptyResult(taskId);
  const dir = taskDir(RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", output: "recovered" }));

  let r: ReturnType<typeof reconcileRun> | undefined;
  assert.doesNotThrow(() => {
    r = reconcileRun(RUN.id, ALIVE, defaultContainerReap, defaultContainerExitInfo, busyOn("backfillTaskResult", taskId));
  }, "a SQLITE_BUSY throw in the backfill pass must be swallowed");
  const t = getTask(taskId)!;
  assert.equal(t.status, "complete", "status untouched");
  assert.equal(t.result, undefined, "the backfill write threw → result stays empty, retried on a later pass");
  assert.equal(r!.taskChanges.filter((c) => c.taskId === taskId).length, 0);
});

test("FG-459: a write throw inside the fanout-parent pass does not propagate and does not abort the run-level check", () => {
  // A fanout parent stuck running with all children complete → the fanout pass
  // lands it fail-safe via markTaskFailed (FG-479: never complete from child
  // aggregation alone — the parent's own finalize never ran). Force that write
  // to throw.
  insertTask(mkTask("fp-busy", { status: "running" }));
  insertTask(mkTask("fp-child-1", { parentId: "fp-busy", status: "complete" }));
  insertTask(mkTask("fp-child-2", { parentId: "fp-busy", status: "complete" }));

  let r: ReturnType<typeof reconcileRun> | undefined;
  assert.doesNotThrow(() => {
    r = reconcileRun(RUN.id, ALIVE, defaultContainerReap, defaultContainerExitInfo, busyOn("markTaskFailed", "fp-busy"));
  }, "a throw finalizing a fanout parent must not propagate");
  assert.equal(getTask("fp-busy")!.status, "running", "the parent-failing write threw → left running");
  assert.equal(r!.taskChanges.filter((c) => c.taskId === "fp-busy").length, 0);
  // The run-level completion check still ran to a verdict (no escaping throw): the
  // parent is non-terminal so the run is NOT completed.
  assert.equal(r!.runChange, undefined);
});

// FG-463: each (status write + its paired audit events) group commits in ONE
// transaction. FG-459's busyOn throws on the status write itself (nothing lands);
// FG-463's concern is the OTHER half — the status write SUCCEEDS and a SUBSEQUENT
// statement in the group throws (SQLITE_BUSY on the 2nd logEvent). Without the
// transaction the status would be left changed WITHOUT its reconciled event; with
// it, the whole group rolls back. writeThenBusyOn performs the REAL write, then
// throws — simulating exactly that post-write failure inside the group.
function writeThenBusyOn(method: keyof ReconcileWriters, failingTaskId: string): ReconcileWriters {
  const busyAfter = <T>(realWrite: () => T): T => {
    realWrite(); // the real status write — commits within the group's transaction...
    const e = new Error("SQLITE_BUSY: database is locked") as Error & { code?: string };
    e.code = "SQLITE_BUSY";
    throw e; // ...then a later statement in the SAME group throws → whole group rolls back
  };
  return {
    markTaskComplete: (id, result) =>
      method === "markTaskComplete" && id === failingTaskId
        ? busyAfter(() => defaultReconcileWriters.markTaskComplete(id, result))
        : defaultReconcileWriters.markTaskComplete(id, result),
    markTaskFailed: (id, error, result) =>
      method === "markTaskFailed" && id === failingTaskId
        ? busyAfter(() => defaultReconcileWriters.markTaskFailed(id, error, result))
        : defaultReconcileWriters.markTaskFailed(id, error, result),
    backfillTaskResult: (id, result) =>
      method === "backfillTaskResult" && id === failingTaskId
        ? busyAfter(() => defaultReconcileWriters.backfillTaskResult(id, result))
        : defaultReconcileWriters.backfillTaskResult(id, result),
  };
}

test("FG-463: a throw AFTER the status write rolls the whole group back — status unchanged, no partial event; a later pass reconciles cleanly", () => {
  // Containerized task, container GONE, no result → orphaned fail branch
  // (markTaskFailed + task.failed + task.reconciled, all in one transaction).
  insertContainerized(mkTask("t-atomic", { status: "running" }));

  let r: ReturnType<typeof reconcileRun> | undefined;
  assert.doesNotThrow(() => {
    r = reconcileRun(RUN.id, GONE, defaultContainerReap, defaultContainerExitInfo, writeThenBusyOn("markTaskFailed", "t-atomic"));
  }, "the rolled-back group's throw is swallowed by the FG-459 outer guard");

  // Rolled back: status did NOT change, and NO partial event landed.
  assert.equal(getTask("t-atomic")!.status, "running", "the status write must roll back when a later statement in the group throws");
  const types1 = eventsForTask("t-atomic").map((e) => e.eventType);
  assert.ok(!types1.includes("task.failed"), "no partial task.failed event");
  assert.ok(!types1.includes("task.reconciled"), "no partial task.reconciled event");
  assert.equal(r!.taskChanges.filter((c) => c.taskId === "t-atomic").length, 0, "no bogus change recorded");

  // The group is retried WHOLE on a later idempotent pass (normal writers): the
  // status change AND both events land together — no duplicate events from the
  // rolled-back attempt (it inserted nothing).
  const r2 = reconcileRun(RUN.id, GONE);
  assert.equal(getTask("t-atomic")!.status, "failed", "a later pass applies the whole group cleanly");
  const types2 = eventsForTask("t-atomic").map((e) => e.eventType);
  assert.ok(types2.includes("task.failed"), "task.failed lands on the clean pass");
  assert.equal(types2.filter((t) => t === "task.reconciled").length, 1, "exactly one reconciled event — no duplicate from the rollback");
  assert.equal(r2.taskChanges.filter((c) => c.taskId === "t-atomic" && c.to === "failed").length, 1);
});

test("FG-463: complete-branch rollback — markTaskComplete commits then a later statement throws → status rolled back, no partial event, clean re-apply", () => {
  // Container-gone WITH a valid result → the markTaskComplete-gated complete
  // branch (structurally different from the fail branches: the write is inside
  // the transaction's `if`, and the taskChanges push is gated on the txn result).
  insertContainerized(mkTask("t-atomic-complete", { status: "running" }));
  const dir = taskDir(RUN.id, "t-atomic-complete");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", output: "done" }));

  assert.doesNotThrow(() => {
    reconcileRun(RUN.id, GONE, defaultContainerReap, defaultContainerExitInfo, writeThenBusyOn("markTaskComplete", "t-atomic-complete"));
  });
  assert.equal(getTask("t-atomic-complete")!.status, "running", "the complete write must roll back");
  const t1 = eventsForTask("t-atomic-complete").map((e) => e.eventType);
  assert.ok(!t1.includes("task.completed") && !t1.includes("task.reconciled"), "no partial events");

  const r2 = reconcileRun(RUN.id, GONE);
  assert.equal(getTask("t-atomic-complete")!.status, "complete", "clean re-apply on the next pass");
  const t2 = eventsForTask("t-atomic-complete").map((e) => e.eventType);
  assert.ok(t2.includes("task.completed"), "task.completed lands on the clean pass");
  assert.equal(t2.filter((e) => e === "task.reconciled").length, 1, "exactly one reconciled event — no duplicate");
});

test("FG-463: Mode-A backfill rollback — backfillTaskResult commits then a later statement throws → result stays empty, no reconciled event, clean re-apply (result.json write stays outside the txn)", () => {
  // A complete task with an empty DB result + a recoverable result.json → the
  // Mode-A backfill pass. Structurally different: the best-effort result.json
  // write runs BEFORE the transaction, so a rollback leaves the disk mirror
  // written but the DB result empty (no partial reconciled event).
  const taskId = "t-atomic-backfill";
  makeCompleteEmptyResult(taskId);
  const dir = taskDir(RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", output: "recovered" }));

  assert.doesNotThrow(() => {
    reconcileRun(RUN.id, ALIVE, defaultContainerReap, defaultContainerExitInfo, writeThenBusyOn("backfillTaskResult", taskId));
  });
  assert.equal(getTask(taskId)!.result, undefined, "the backfill write must roll back — DB result stays empty");
  const t1 = eventsForTask(taskId).map((e) => e.eventType);
  assert.equal(t1.filter((e) => e === "task.reconciled").length, 0, "no partial reconciled event from the rolled-back backfill");

  const r2 = reconcileRun(RUN.id, ALIVE);
  assert.notEqual(getTask(taskId)!.result, undefined, "clean re-apply backfills the result");
  const t2 = eventsForTask(taskId).map((e) => e.eventType);
  assert.equal(t2.filter((e) => e === "task.reconciled").length, 1, "exactly one reconciled event on the clean pass");
  assert.equal(r2.taskChanges.filter((c) => c.taskId === taskId).length, 1);
});

// FG-461 (review round): attachedExitEvidence's source disambiguation. The
// attached-exit dispatch tests (invoke.integration.test.ts / runNext.integration.test.ts) all run
// against a shared project dir, so they only cover source: "project_dir_shared".
// This exercises the source: "worktree" branch directly — a dedicated
// worktreePath is task-exclusive, confident evidence, and flips both `source`
// and `worktreePathChecked` (which changes the operator-facing disclosure).
test("FG-461: attachedExitEvidence with a dedicated worktreePath reports source=worktree and checks that path", () => {
  const wt = makeDirtyGitRepo();
  try {
    const ev = attachedExitEvidence({ containerName: "forge-t-wt", worktreePath: wt, projectDir: "/some/shared/proj", exitCode: 1, oomKilled: false });
    assert.equal(ev.source, "worktree", "a dedicated worktree is task-exclusive evidence");
    assert.equal(ev.worktreePathChecked, wt, "the worktree path is what's probed, not the shared projectDir");
    assert.equal(ev.containerLiveness, "gone");
    assert.equal(ev.resultState, "absent");
    assert.equal(ev.recoverableStdoutResult, false);
    assert.equal(ev.exitCode, 1);
    assert.equal(ev.oomKilled, false);
    assert.ok(ev.changedFiles.some((f) => f.includes("changed-file.txt")), "changed files come from the worktree");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("FG-461: attachedExitEvidence with no worktreePath falls back to the shared projectDir with source=project_dir_shared", () => {
  const proj = makeDirtyGitRepo();
  try {
    const ev = attachedExitEvidence({ containerName: "forge-t-shared", worktreePath: undefined, projectDir: proj, exitCode: 137, oomKilled: true });
    assert.equal(ev.source, "project_dir_shared", "no dedicated worktree → the shared-dir hedge applies");
    assert.equal(ev.worktreePathChecked, proj);
    assert.equal(ev.exitCode, 137);
    assert.equal(ev.oomKilled, true);
    assert.ok(ev.changedFiles.some((f) => f.includes("changed-file.txt")));
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

// FG-484: reconcileRun's run-level completion check reads `run.status ===
// "active"` early, then does the task-level passes above (each of which can
// take real time — worktree scans, docker calls), and only THEN calls
// finalizeRunIfSettled. A concurrent `forge cancel` can abandon the run
// anywhere in that window; the early "active" read is just this function's
// stale local snapshot. gate.ts and runNext.ts's finalize sites have their own
// dedicated race tests (runNext.integration.test.ts's "gate: FG-484" / "AWN-2" cases);
// this is reconcile.ts's — using the same injectable-writers seam FG-459's
// SQLITE_BUSY tests use, to land the concurrent abandon deterministically
// between the task-level write and the run-level finalize check.
test("FG-484: a concurrent cancel abandoning the run between reconcile's task-level pass and its run-level finalize check must not resurrect it to complete", () => {
  insertContainerized(mkTask("t-race", { status: "running" }));
  const raceWriters: ReconcileWriters = {
    ...defaultReconcileWriters,
    markTaskFailed: (id, error, result) => {
      defaultReconcileWriters.markTaskFailed(id, error, result);
      // The concurrent `forge cancel` — lands after the task-level orphan
      // write above, before reconcileRun reaches its run-level check.
      updateRunStatus(RUN.id, "abandoned");
    },
  };

  const r = reconcileRun(RUN.id, GONE, defaultContainerReap, defaultContainerExitInfo, raceWriters);

  assert.equal(getTask("t-race")!.status, "failed", "the task-level orphan write still applies");
  assert.equal(getRun(RUN.id)!.status, "abandoned", "FG-484: the run must stay abandoned, never resurrected to complete");
  assert.equal(r.runChange, undefined, "no run-level completion change reported");
  const eventTypes = eventsForRun(RUN.id).map((e) => e.eventType);
  assert.ok(!eventTypes.includes("run.completed"), "no run.completed event for a finalize refused by the abandoned re-read");
  assert.ok(!eventTypes.includes("run.reconciled"), "onCompleted's paired run.reconciled event must not fire when the write is refused");
});

// ── FG-492: container disappearance diagnostics ─────────────────────────────
// Four states an operator/orchestrator must be able to tell apart without
// forge asserting an unproven "killed" cause. See show.ts's describeContainerEvidence.

test("FG-492: a started container that disappears with no container.exited event → containerExitedEventObserved=false, rendered as 'disappeared without terminal evidence', never a proven kill", () => {
  insertContainerized(mkTask("t-disappeared", { status: "running" }));
  const r = reconcileRun(RUN.id, GONE);
  assert.deepEqual(r.taskChanges, [{ taskId: "t-disappeared", from: "running", to: "failed", reason: "container_gone_no_result" }]);

  const events = eventsForTask("t-disappeared");
  const containerEvidence = getContainerCausalEvidenceFromEvents(events)!;
  assert.ok(containerEvidence, "reconcile must record container causal evidence, even for a bare no-result orphan");
  assert.equal(containerEvidence.containerExitedEventObserved, false, "no container.exited event was ever recorded for this task");
  assert.equal(containerEvidence.containerName, "forge-t-disappeared");

  const summary = describeContainerEvidence(containerEvidence);
  assert.match(summary, /disappeared without terminal evidence/, "must use the ticket's required phrase");
  assert.doesNotMatch(summary, /killed/i, "must never assert an unproven kill");

  const missing = missingContainerEvidence(containerEvidence);
  assert.ok(missing.some((m) => m.includes("no container.exited event")));
});

test("FG-492: an exited container with exit code 137/OOM evidence is rendered as a CONFIRMED exit, distinct from a disappeared container", () => {
  const proj = makeDirtyGitRepo();
  try {
    insertContainerized(mkTask("t-oom-evidence", { status: "running", worktreePath: proj }));
    const exitInfo = () => ({ exitCode: 137, oomKilled: true, signal: "SIGKILL", dockerStateError: "" });
    const r = reconcileRun(RUN.id, GONE, defaultContainerReap, exitInfo);
    assert.equal(r.taskChanges[0]?.reason, "container_oom_killed");

    const events = eventsForTask("t-oom-evidence");
    const containerEvidence = getContainerCausalEvidenceFromEvents(events)!;
    assert.ok(containerEvidence);
    // FG-492: architecturally separate booleans — Forge never observed a
    // container.exited event for THIS task (that's exactly why reconcile is
    // the one classifying it), even though docker inspect still had exit
    // evidence to offer. The two disagreeing is itself diagnostic.
    assert.equal(containerEvidence.containerExitedEventObserved, false);
    assert.equal(containerEvidence.dockerExitCode, 137);
    assert.equal(containerEvidence.oomKilled, true);
    assert.equal(containerEvidence.signal, "SIGKILL");

    const summary = describeContainerEvidence(containerEvidence);
    assert.match(summary, /disappeared without terminal evidence/, "still a disappearance — Forge itself never observed the exit");
    assert.match(summary, /exit code 137/);
    assert.match(summary, /OOMKilled=true/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("FG-492: a fanout parent's derived failure carries NO container evidence and is never labeled a killed agent", () => {
  insertTask(mkTask("fanout-parent-evidence", { status: "running" }));
  insertTask(mkTask("fanout-child-evidence-1", { parentId: "fanout-parent-evidence", status: "complete" }));
  insertTask(mkTask("fanout-child-evidence-2", { parentId: "fanout-parent-evidence", status: "complete" }));

  const r = reconcileRun(RUN.id, ALIVE);
  assert.equal(r.taskChanges.find((c) => c.taskId === "fanout-parent-evidence")?.reason, "fanout_wave_unfinalized");

  const events = eventsForTask("fanout-parent-evidence");
  assert.ok(!events.some((e) => e.eventType === "container.started"), "a fanout parent never gets its own agent container");
  const containerEvidence = getContainerCausalEvidenceFromEvents(events);
  assert.equal(containerEvidence, undefined, "no container evidence exists — there was never a container to inspect");

  const failed = events.find((e) => e.eventType === "task.failed")!;
  const errorText = (failed.payload as Record<string, unknown>).error as string;
  assert.doesNotMatch(errorText, /killed/i, "a fanout parent's derived failure must never read as a killed agent");
});
