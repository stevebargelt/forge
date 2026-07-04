import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun, getRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { eventsForTask, eventsForRun, logEvent } from "../store/events.js";
import { taskDir } from "../util/paths.js";
import { reconcileRun, reconcileRuns } from "./reconcile.js";
import type { OrphanEvidence } from "./failure-kind.js";
import { orphanRecoveryMessage } from "../cli/commands/show.js";
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
    assert.match(t.error ?? "", /--force/);

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
